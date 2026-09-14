import type { LLMRequest } from '@mazi/core';
import { modelIdOf, offeringIdOf, providerIdOf, ulid } from '@mazi/core';
import type { CatalogService } from '../catalog/service.js';
import type {
    ExecutorRoundContext,
    RoundEstimate,
    RoundPin,
    RoundResult,
} from '../gts/round-types.js';
import { type DefaultEventBus, newHarnessEvent } from '../observability/index.js';
import { RoundExecutor, type RoundOutcome, type RoundStreamListener } from '../provider/index.js';
import { measureContext } from './context-measure.js';
import { describeLlmError, isModelRelatedError } from './llm-error.js';
import type { ModelResolver } from './model-resolver.js';
import {
    outputBreakdown,
    pricingSnapshot,
    roundCost,
    roundEstimatedCost,
    roundEstimate,
    toRoundResult,
} from './round-accounting.js';

/** 模型恢复回调入参：失败时的 provider / 模型（供按渠道定向重同步）。 */
export interface ModelRecoveryRequest {
    providerId?: string;
    modelId?: string;
}

/** 模型恢复回调返回值：修正后的 provider 与模型 id。 */
export interface ModelRecoveryResult {
    providerId?: string;
    modelId?: string;
}

export type ModelRecoveryFn = (
    request: ModelRecoveryRequest,
) => Promise<ModelRecoveryResult | undefined>;

export interface RoundRunnerDeps {
    bus: DefaultEventBus;
    executor: RoundExecutor;
    resolver: ModelResolver;
}

/**
 * RoundRunner —— LLM 轮次状态机：轮次调度、模型恢复自愈、上下文计量基线、
 * 结算（估算/成本/价目快照）与目录凭证闭环。基线三字段仅在同一 Task 内有效，
 * 由宿主在每轮 run 开始时调用 resetBaselines() 重置。
 */
export class RoundRunner {
    private readonly bus: DefaultEventBus;
    private readonly executor: RoundExecutor;
    private readonly resolver: ModelResolver;
    /** 上一轮上下文总量（估算跨轮 delta 用；仅同一 Task 内有效） */
    private lastContextTotal?: number;
    /** 上一轮消息条数（取本步新增内容 diff 用；仅同一 Task 内有效） */
    private lastMessageCount?: number;
    /** 最近一次计量的 taskId（跨 Task 时重置基线） */
    private lastTaskId?: string;
    /** 可选目录账本：接入后每轮 usage 追加凭证（凭证闭环） */
    private catalogService?: CatalogService;
    /** 可选模型恢复：模型名被厂商拒绝时重同步并换模重试一次 */
    private recovery?: ModelRecoveryFn;

    constructor(deps: RoundRunnerDeps) {
        this.bus = deps.bus;
        this.executor = deps.executor;
        this.resolver = deps.resolver;
    }

    /** 接入目录与账本：此后每轮 LLM 调用按钉死的 offering 价目追加 UsageRecord。 */
    setCatalog(service: CatalogService): void {
        this.catalogService = service;
    }

    /** 接入模型恢复：模型名被厂商拒绝时重同步并换模重试一次（llm.error 事件后自愈）。 */
    setRecovery(fn: ModelRecoveryFn): void {
        this.recovery = fn;
    }

    /** 每轮 run 前重置上下文基线：首个 round 的 delta 从 0 起算，不与上一个会话串味。 */
    resetBaselines(): void {
        this.lastContextTotal = undefined;
        this.lastMessageCount = undefined;
        this.lastTaskId = undefined;
    }

    /**
     * 单次 LLM 轮次：经 provider-runtime RoundExecutor（重试/failover 在 provider-runtime 内）。
     * 具备 goalId/taskId 时，把 provider 原始流式增量包装成 llm.stream_event 实时发到事件总线
     * （docs/web/流式响应设计.md §2）；同一轮的多次网络尝试共享 streamId，attempt 区分重试。
     */
    async requestRound(
        rootGoalId: string,
        ctx: ExecutorRoundContext,
        reasoningLevel?: string,
    ): Promise<RoundResult> {
        // 不设 request.model：模型 id 交由 provider-runtime 按候选（candidate.modelId）解析，
        // 避免占位 modelId（goal-executor 缺省 'default'）覆盖真实模型而报 unknown model。
        const request: LLMRequest = {
            ...(ctx.systemPrompt ? { system: ctx.systemPrompt } : {}),
            messages: ctx.messages,
            ...(ctx.tools.length > 0 ? { tools: ctx.tools } : {}),
            // 'off' 时不发送 reasoningEffort：pi-ai 据此下发 thinking:{type:'disabled'}；
            // 若原样发送 'off' 会被判为「开启思考」并带上非法 reasoning_effort，导致无输出。
            ...(reasoningLevel && reasoningLevel.length > 0 && reasoningLevel !== 'off'
                ? { extra: { reasoningEffort: reasoningLevel } }
                : {}),
        };
        // runtime 维度：请求发出前的上下文分段计量（同一 Task 内累计 delta / 新增内容）
        const sameTask = ctx.taskId !== undefined && ctx.taskId === this.lastTaskId;
        const contextUsage = measureContext(
            ctx,
            sameTask ? this.lastContextTotal : undefined,
            sameTask ? this.lastMessageCount : ctx.baseMessageCount,
            this.resolver.contextWindowOf(ctx.model.providerId, ctx.model.modelId),
        );
        const streamId = ulid();
        const streamable = ctx.goalId !== undefined && ctx.taskId !== undefined;
        const onStream: RoundStreamListener | undefined = streamable
            ? (streamEvent) => {
                  this.bus.emit(
                      newHarnessEvent({
                          type: 'llm.stream_event',
                          rootGoalId,
                          goalId: ctx.goalId,
                          taskId: ctx.taskId,
                          attributes: {
                              'gen_ai.provider.name': streamEvent.providerId,
                              'gen_ai.request.model': streamEvent.modelId,
                          },
                          payload: {
                              streamId,
                              attempt: streamEvent.attempt,
                              event: streamEvent.event,
                          },
                      }),
                  );
              }
            : undefined;

        let modelOverride: string | undefined;
        for (let attempt = 0; ; attempt += 1) {
            const candidates = this.resolver.buildCandidates(ctx, modelOverride);
            if (candidates.length === 0) {
                throw new Error(`没有可用 provider：${ctx.model.providerId}`);
            }
            const firstProvider = candidates[0]?.provider;
            const resolvedModel =
                modelOverride ??
                (firstProvider !== undefined
                    ? this.resolver.roundModelId(ctx.model.providerId, ctx.model, firstProvider)
                    : undefined);
            try {
                const outcome = await this.executor.execute(request, candidates, onStream);
                if (modelOverride !== undefined) {
                    await this.emitRecovered(
                        rootGoalId,
                        ctx,
                        modelOverride,
                        outcome.metrics.providerId,
                    );
                }
                return await this.finishRound(ctx, contextUsage, outcome);
            } catch (error) {
                const described = describeLlmError(error);
                this.bus.emit(
                    newHarnessEvent({
                        type: 'llm.error',
                        rootGoalId,
                        goalId: ctx.goalId,
                        taskId: ctx.taskId,
                        attributes: {
                            'gen_ai.provider.name': ctx.model.providerId,
                            'harness.level': 'error',
                            ...(described.code !== undefined
                                ? { 'harness.provider_error_code': described.code }
                                : {}),
                        },
                        payload: {
                            code: described.code,
                            message: described.message,
                            model: resolvedModel,
                            attempt,
                        },
                    }),
                );
                await this.bus.flush();
                const recovery = this.recovery;
                const canRecover =
                    attempt === 0 && recovery !== undefined && isModelRelatedError(described);
                if (!canRecover) throw error;
                const recovered = await recovery({
                    providerId: ctx.model.providerId,
                    ...(resolvedModel !== undefined ? { modelId: resolvedModel } : {}),
                }).catch(() => undefined);
                if (recovered?.modelId === undefined) throw error;
                modelOverride = recovered.modelId;
            }
        }
    }

    /** 模型被厂商拒绝后自愈成功：发 provider.recovered。 */
    private async emitRecovered(
        rootGoalId: string,
        ctx: ExecutorRoundContext,
        modelId: string,
        providerId: string,
    ): Promise<void> {
        this.bus.emit(
            newHarnessEvent({
                type: 'provider.recovered',
                rootGoalId,
                goalId: ctx.goalId,
                taskId: ctx.taskId,
                attributes: {
                    'gen_ai.provider.name': providerId,
                    'gen_ai.request.model': modelId,
                    'harness.level': 'info',
                },
                payload: { providerId, modelId },
            }),
        );
        await this.bus.flush();
    }

    private async finishRound(
        ctx: ExecutorRoundContext,
        contextUsage: RuntimeContextBreakdownLike,
        outcome: RoundOutcome,
    ): Promise<RoundResult> {
        const result = toRoundResult(outcome);
        this.lastContextTotal = contextUsage.totalContextTokens;
        this.lastMessageCount = ctx.messages.length;
        this.lastTaskId = ctx.taskId;
        // 输入漂移：有符号（breakdown total − vendor.input），并给出漂移率
        const vendorInput = result.vendorUsage?.inputTokens;
        if (vendorInput !== undefined) {
            const drift = contextUsage.totalContextTokens - vendorInput;
            contextUsage.estimationDriftTokens = drift;
            contextUsage.estimationDriftRate = vendorInput > 0 ? drift / vendorInput : undefined;
        }
        const estimate = roundEstimate(result);
        const schedule = this.resolver.pricingOf(
            outcome.metrics.providerId,
            outcome.metrics.modelId,
        );
        const usage = outcome.metrics.usage;
        const cost =
            usage !== undefined && schedule !== undefined ? roundCost(usage, schedule) : undefined;
        const estimatedCost =
            schedule !== undefined && estimate !== undefined
                ? roundEstimatedCost(contextUsage, estimate, schedule)
                : undefined;
        const output = outputBreakdown(result);
        const pricing = schedule !== undefined ? pricingSnapshot(schedule) : undefined;
        const pin = await this.recordCatalogUsage(outcome);
        return {
            ...result,
            contextUsage,
            ...(pin !== undefined ? { pin } : {}),
            ...(estimate !== undefined ? { estimate } : {}),
            ...(output !== undefined ? { output } : {}),
            ...(pricing !== undefined ? { pricing } : {}),
            ...(cost !== undefined ? { cost } : {}),
            ...(estimatedCost !== undefined ? { estimatedCost } : {}),
        };
    }

    /**
     * 凭证闭环：把本轮 usage 按派发时刻钉死的 offering 价目追加进账本。
     * 目录未收录或无价的 offering 不产生凭证（目录是权威，缺失不阻断对话）。
     */
    private async recordCatalogUsage(outcome: RoundOutcome): Promise<RoundPin | undefined> {
        const service = this.catalogService;
        const usage = outcome.metrics.usage;
        if (service === undefined || usage === undefined) return undefined;
        const offeringId = offeringIdOf(
            providerIdOf(outcome.metrics.providerId),
            modelIdOf(outcome.metrics.modelId),
        );
        try {
            const pin = service.pin(offeringId);
            await service.settle(pin, {
                inputTokens: usage.inputTokens ?? 0,
                outputTokens: usage.outputTokens ?? 0,
                cacheReadTokens: usage.cachedInputTokens ?? 0,
            });
            return {
                offeringId: pin.offeringId,
                pricingPlanId: pin.pricingPlanId,
                catalogEpoch: pin.catalogEpoch,
            };
        } catch {
            // 目录未收录或无价：跳过凭证，不影响本轮对话。
            return undefined;
        }
    }
}

/** finishRound 对 contextUsage 有原地回填（漂移字段），此处显式声明可变视图。 */
type RuntimeContextBreakdownLike = Parameters<typeof measureContext> extends never
    ? never
    : import('@mazi/core').RuntimeContextBreakdown;
