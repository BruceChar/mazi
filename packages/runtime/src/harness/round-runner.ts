import type { LLMRequest } from '@mazi/core';
import { ulid } from '@mazi/core';
import { type DefaultEventBus, newHarnessEvent } from '../events/index.js';
import type { ExecutorRoundContext, RoundPin, RoundResult } from '../gts/round-types.js';
import { modelIdOf, offeringIdOf, providerIdOf } from '../provider/catalog/contract.js';
import type { CatalogService } from '../provider/catalog/service.js';
import type { RoundExecutor, RoundOutcome, RoundStreamListener } from '../provider/index.js';
import { attributeToolCallsToRoundDiff, measureContext } from './context-measure.js';
import { describeLlmError, isModelRelatedError } from './llm-error.js';
import type { ModelResolver } from './model-resolver.js';
import {
    DEFAULT_ESTIMATED_CACHED_RATIO,
    nextEstimatedCachedRatio,
    outputBreakdown,
    pricingSnapshot,
    roundCost,
    roundEstimate,
    roundEstimatedCost,
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
    /** 可选目录账本：接入后每轮 usage 追加凭证（凭证闭环） */
    private catalogService?: CatalogService;
    /** 可选模型恢复：模型名被厂商拒绝时重同步并换模重试一次 */
    private recovery?: ModelRecoveryFn;
    /** 估算用缓存命中率：按会话（Conversation，缺省回退 run）记忆，初始 0.9，随 vendor 上报更新 */
    private readonly estimatedCachedRatios = new Map<string, number>();

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

    /**
     * 单次 LLM 轮次：经 provider-runtime RoundExecutor（重试/failover 在 provider-runtime 内）。
     * 具备 goalId/taskId 时，把 provider 原始流式增量包装成 llm.stream_event 实时发到事件总线
     * （docs/web/流式响应设计.md §2）；同一轮的多次网络尝试共享 streamId，attempt 区分重试。
     */
    async requestRound(
        rootGoalId: string,
        ctx: ExecutorRoundContext,
        reasoningLevel?: string,
        /** 归属会话（Conversation）：估算缓存命中率按会话记忆，跨 run/task 更新。 */
        conversationId?: string,
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
            // 协作式停止：调用方 signal 透传到 provider，取消即报 aborted。
            ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        };
        // runtime 维度：请求发出前的上下文分段计量。ContextManager 持有跨轮 delta 基线；
        // 未装配 context 的调用方（如独立 TOC 分析）退回无状态计量。
        const contextWindow = this.resolver.contextWindowOf(
            ctx.model.providerId,
            ctx.model.modelId,
        );
        const contextUsage = ctx.context
            ? ctx.context.measure(contextWindow)
            : measureContext(ctx, undefined, ctx.baseMessageCount, contextWindow);
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
                return await this.finishRound(rootGoalId, conversationId, contextUsage, outcome);
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

    /** 该会话当前的估算缓存命中率（未上报过 → 初始 0.9）。 */
    private estimatedCachedRatioFor(key: string | undefined): number {
        if (key === undefined) return DEFAULT_ESTIMATED_CACHED_RATIO;
        return this.estimatedCachedRatios.get(key) ?? DEFAULT_ESTIMATED_CACHED_RATIO;
    }

    private async finishRound(
        rootGoalId: string,
        conversationId: string | undefined,
        contextUsage: RuntimeContextBreakdownLike,
        outcome: RoundOutcome,
    ): Promise<RoundResult> {
        const result = toRoundResult(outcome);
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
        // 估算缓存命中率 pre_cached_ratio：本轮先用“上一轮 vendor”累计的命中率（初始 0.9），
        // 本轮 vendor 返回后再更新，供下一轮使用；按会话记忆（缺省回退 run）。
        const ratioKey = conversationId ?? rootGoalId;
        const cachedInputRatio = this.estimatedCachedRatioFor(ratioKey);
        if (estimate !== undefined) estimate.cachedRatio = cachedInputRatio;
        // IN = in × cachedRatio × cached_price + in × (1 − cachedRatio) × miss_price；OUT = out × out_price。
        const estimatedCost =
            schedule !== undefined && estimate !== undefined
                ? roundEstimatedCost(contextUsage, estimate, schedule, cachedInputRatio)
                : undefined;
        // 本轮 vendor 上报 → 更新会话命中率，用于后续轮次估算。
        this.estimatedCachedRatios.set(
            ratioKey,
            nextEstimatedCachedRatio(
                cachedInputRatio,
                result.vendorUsage?.cacheReadInputTokens,
                vendorInput,
            ),
        );
        const output = outputBreakdown(result);
        // 本轮 tool-call 参数属于本轮 output：归到产出它的这一轮 diff（不再挂到下一轮 input）。
        attributeToolCallsToRoundDiff(contextUsage, result.toolCalls ?? []);
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
type RuntimeContextBreakdownLike =
    Parameters<typeof measureContext> extends never
        ? never
        : import('@mazi/core').RuntimeContextBreakdown;
