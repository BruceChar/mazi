import type {
    Capacity,
    EventBus,
    HarnessError,
    LLMDriver,
    LLMStreamEvent,
    MemoryStore,
    PolicyEngine,
    Step,
    TokenTotals,
    ToolExecutionResult,
    ToolInvoker,
    Turn,
    Usage,
    VendorUsage,
} from '@mazi/core';
import { ulid } from '@mazi/core';
import { newHarnessEvent } from '@mazi/observability';
import type { ContextMeter, CostCalculator } from '@mazi/usage';
import { backfillDrift, emptyTokenTotals, isDriftExcessive } from '@mazi/usage';
import { buildContext } from './context-builder';

export type TurnStopReason =
    | 'final-answer'
    | 'max-steps'
    | 'timeout'
    | 'blocked-tool'
    | 'driver-error'
    | 'budget-exceeded';

export interface TurnExecutionOutcome {
    /** turn 执行结果（成功或失败；retry/abort 决策由策略层依据 reason 与 failureSignals 做出） */
    ok: boolean;
    reason: TurnStopReason;
    steps: Step[];
    finalMessage?: string;
    error?: HarnessError;
    accumulatedTokens: TokenTotals;
    accumulatedCostUsd: number;
}

export interface ExecutorDeps {
    /** 按 providerId 取驱动（故障转移时切换 capacity.model 后取对应驱动） */
    driverFor: (providerId: string) => LLMDriver;
    /** 本 Turn 可用候选模型（路由 selectAll 顺序）；首个为 capacity.model */
    fallbackModels: () => ExecutorDepsFallbackModel[];
    policy: PolicyEngine;
    memory: MemoryStore;
    bus: EventBus;
    tools: ToolInvoker;
    meter: ContextMeter;
    costs: CostCalculator;
    /** 模型 context window（token） */
    contextWindow: number;
    /** 选中 Provider 的定价表（装配期由 runtime 从 ProviderPool 绑定注入） */
    pricing: (model: Capacity['model']) => Parameters<CostCalculator['calculate']>[0];
    systemPrompt?: string;
    /** Step 级决策上下文快照（审计用） */
    promptVersion?: string;
    now?: () => number;
}

/** 故障转移候选模型（与 provider.selected 顺序一致） */
export interface ExecutorDepsFallbackModel {
    model: Capacity['model'];
}

interface RoundResult {
    text: string;
    reasoning: string;
    toolCalls: { callId: string; toolName: string; arguments: Record<string, unknown> }[];
    vendorUsage?: VendorUsage;
    ttftMs: number;
    totalMs: number;
    finishReason?: string;
    driverError?: Error;
}

function baseEvent(
    type: Parameters<EventBus['emit']>[0]['type'],
    sessionId: string,
    turnId?: string,
    stepId?: string,
) {
    return newHarnessEvent({ type, sessionId, turnId, stepId });
}

/**
 * MVP Executor（feature F10）：
 * 执行单个 Turn：循环 模型调用 → tool_call → Policy → 工具 → 观察，直至模型给出最终回答、
 * 步数/超时/预算上限或工具被 Policy 拦截。每次调用从 memory 重建上下文（天然支持断点续传语义：
 * 若此前已持久化部分 Steps，本方法直接续跑，不重复已完成的 Step）。
 * 采集点：A=context 分段计数（ContextMeter）、B=vendor usage+timing、C=计价+漂移回填。
 */
export class Executor {
    constructor(private readonly deps: ExecutorDeps) {}

    async executeTurn(turn: Turn, capacity: Capacity): Promise<TurnExecutionOutcome> {
        const sessionId = turn.sessionId;
        const turnId = turn.turnId;
        const startedAt = this.now();
        const timeoutMs = capacity.budget.timeoutMs;
        // 从 memory 重建已完成 Steps（支持恢复与续跑）
        let steps = (await this.deps.memory.listSteps(turnId)).sort((a, b) => a.seq - b.seq);
        // 累计用量：checkpoint 中已累计的部分作为起点
        const accumulatedTokens = turn.checkpoint
            ? { ...turn.checkpoint.accumulatedUsage }
            : emptyTokenTotals();
        let accumulatedCostUsd = turn.checkpoint?.accumulatedCostUsd ?? 0;
        let prevTotalTokens: number | undefined = steps.length
            ? steps[steps.length - 1]?.usage?.runtime.totalContextTokens
            : undefined;
        const budgetMaxSteps = capacity.budget.maxSteps;

        const finalize = async (
            outcome: Omit<TurnExecutionOutcome, 'accumulatedTokens' | 'accumulatedCostUsd'>,
        ): Promise<TurnExecutionOutcome> => {
            const result: TurnExecutionOutcome = {
                ...outcome,
                accumulatedTokens,
                accumulatedCostUsd,
            };
            turn.status = outcome.ok ? 'succeeded' : 'failed';
            turn.stepIds = steps.map((s) => s.stepId);
            await this.deps.memory.saveTurn(turn);
            return result;
        };

        let roundIndex = 0;
        // 首个 model 调用循环条件：模型有 tool_call 或仍有未消费的 tool 意图则继续
        let wantsContinue = true;
        while (wantsContinue) {
            const stepCount = steps.length;
            if (budgetMaxSteps !== undefined && stepCount >= budgetMaxSteps) {
                return finalize({
                    ok: false,
                    reason: 'max-steps',
                    steps,
                    error: this.err('max-steps', '达到 Turn 最大步数'),
                });
            }
            if (timeoutMs !== undefined && this.now() - startedAt > timeoutMs) {
                return finalize({
                    ok: false,
                    reason: 'timeout',
                    steps,
                    error: this.err('timeout', 'Turn 超时'),
                });
            }
            // 预算上限检查（成本累计口径）
            if (
                capacity.budget.maxCostUsd !== undefined &&
                accumulatedCostUsd > capacity.budget.maxCostUsd
            ) {
                return finalize({
                    ok: false,
                    reason: 'budget-exceeded',
                    steps,
                    error: this.err('budget-exceeded', 'Turn 累计成本超出预算切片'),
                });
            }
            // 采集点 A：构建上下文并分段计数
            const built = buildContext({
                systemPrompt: this.deps.systemPrompt,
                steps,
                newInput: roundIndex === 0 ? turn.contract.statement : '',
                tools: capacity.tools,
            });
            const runtime = this.deps.meter.measure(
                built.sections,
                this.deps.contextWindow,
                prevTotalTokens,
            );
            prevTotalTokens = runtime.totalContextTokens;
            const llmReqAt = this.now();
            this.deps.bus.emit({
                ...baseEvent('llm.request', sessionId, turnId),
                attributes: { 'gen_ai.request.model': capacity.model.modelId },
                payload: { turnId, roundIndex },
            });
            // 采集点 B：驱动调用（含 Provider 故障转移：按候选顺序重试本轮）
            const round = await this.callWithFallback(
                capacity,
                sessionId,
                turnId,
                built.context,
                llmReqAt,
            );
            if (round === undefined) {
                return finalize({
                    ok: false,
                    reason: 'driver-error',
                    steps,
                    error: this.err('driver-error', '所有候选 Provider 均失败', true),
                });
            }
            // 采集点 C：计价 + 漂移回填
            const vendor = round.vendorUsage ?? {
                inputTokens: 0,
                outputTokens: 0,
                reportedByVendor: false,
            };
            backfillDrift(runtime, vendor);
            if (isDriftExcessive(runtime.estimationDriftTokens ?? 0, runtime.totalContextTokens)) {
                process.stderr.write(
                    `[warn] estimation drift >5%: ${runtime.estimationDriftTokens} tokens (turn=${turnId})\n`,
                );
            }
            const cost = this.deps.costs.calculate(this.deps.pricing(capacity.model), vendor);
            const usage: Usage = {
                vendor,
                runtime,
                cost,
                timing: {
                    ttftMs: round.ttftMs,
                    totalMs: round.totalMs,
                    tokensPerSecond:
                        round.totalMs > 0
                            ? (vendor.outputTokens + vendor.inputTokens) / (round.totalMs / 1000)
                            : 0,
                },
            };
            addVendorTokens(accumulatedTokens, vendor);
            accumulatedCostUsd += cost.totalCostUsd;
            this.deps.bus.emit({
                ...baseEvent('llm.response', sessionId, turnId),
                attributes: {
                    'gen_ai.request.model': capacity.model.modelId,
                    'gen_ai.usage.input_tokens': vendor.inputTokens,
                    'gen_ai.usage.output_tokens': vendor.outputTokens,
                    'harness.runtime.context.total_tokens': runtime.totalContextTokens,
                    'harness.runtime.context.system_prompt_ratio': runtime.systemPromptRatio,
                },
                payload: { turnId, cost: cost.totalCostUsd },
            });

            const roundSteps: Step[] = [];
            const seqBase = steps.length;
            // assistant/thinking Step（本轮 LLM 输出；承载完整 usage）
            const assistantText = round.text.length > 0 ? round.text : round.reasoning;
            const assistantStep = this.step(
                turn,
                sessionId,
                seqBase,
                'thinking',
                { content: assistantText },
                capacity,
                usage,
            );
            assistantStep.status = 'ok';
            assistantStep.endedAt = this.now();
            roundSteps.push(assistantStep);
            this.deps.bus.emit({
                ...baseEvent('step.started', sessionId, turnId, assistantStep.stepId),
            });
            this.deps.bus.emit({
                ...baseEvent('step.ended', sessionId, turnId, assistantStep.stepId),
            });
            await this.deps.memory.saveStep(assistantStep);
            await this.saveCheckpoint(
                turn,
                steps.concat(roundSteps),
                accumulatedTokens,
                accumulatedCostUsd,
            );

            // tool_call 执行
            if (round.toolCalls.length > 0) {
                for (let i = 0; i < round.toolCalls.length; i++) {
                    const tc = round.toolCalls[i];
                    const toolStep = this.step(
                        turn,
                        sessionId,
                        seqBase + 1 + i,
                        'tool_call',
                        { toolName: tc.toolName, arguments: tc.arguments, callId: tc.callId },
                        capacity,
                    );
                    toolStep.status = 'running';
                    this.deps.bus.emit({
                        ...baseEvent('step.started', sessionId, turnId, toolStep.stepId),
                    });
                    // 预算累计回填（policy 引擎按累计成本校验预算切片）
                    const settable = this.deps.policy as {
                        setAccumulatedCostUsd?: (v: number) => void;
                    };
                    settable.setAccumulatedCostUsd?.(accumulatedCostUsd);
                    const verdict = await this.deps.policy.checkToolCall(
                        capacity,
                        tc.toolName,
                        tc.arguments,
                    );
                    if (!verdict.pass) {
                        toolStep.status = 'blocked';
                        toolStep.error = this.err('tool-blocked', verdict.reason ?? 'policy 拒绝');
                        toolStep.endedAt = this.now();
                        await this.deps.memory.saveStep(toolStep);
                        this.deps.bus.emit({
                            ...baseEvent('tool.blocked', sessionId, turnId, toolStep.stepId),
                            payload: { toolName: tc.toolName, reason: verdict.reason },
                        });
                        this.deps.bus.emit({
                            ...baseEvent('step.ended', sessionId, turnId, toolStep.stepId),
                        });
                        steps = steps.concat(roundSteps, toolStep);
                        await this.saveCheckpoint(
                            turn,
                            steps,
                            accumulatedTokens,
                            accumulatedCostUsd,
                        );
                        await this.deps.memory.saveTurn(turn);
                        return {
                            ok: false,
                            reason: 'blocked-tool',
                            steps,
                            error: toolStep.error,
                            accumulatedTokens,
                            accumulatedCostUsd,
                        };
                    }
                    this.deps.bus.emit({
                        ...baseEvent('tool.invoke', sessionId, turnId, toolStep.stepId),
                        payload: { toolName: tc.toolName },
                    });
                    const result = await this.deps.tools.invoke(tc.toolName, tc.arguments);
                    toolStep.status = 'ok';
                    toolStep.endedAt = this.now();
                    roundSteps.push(toolStep);
                    // observation Step：观察回注（含错误结果）
                    const obsSeq = seqBase + 1 + round.toolCalls.length + i;
                    const observation = this.observationStep(
                        turn,
                        sessionId,
                        obsSeq,
                        tc.toolName,
                        result,
                    );
                    roundSteps.push(observation);
                    this.deps.bus.emit({
                        ...baseEvent('tool.result', sessionId, turnId, toolStep.stepId),
                        payload: { ok: result.ok, toolName: tc.toolName },
                    });
                    this.deps.bus.emit({
                        ...baseEvent('step.ended', sessionId, turnId, toolStep.stepId),
                    });
                    await this.deps.memory.saveStep(toolStep);
                    await this.deps.memory.saveStep(observation);
                }
            } else {
                // 最终回答
                steps = steps.concat(roundSteps);
                await this.saveCheckpoint(turn, steps, accumulatedTokens, accumulatedCostUsd);
                const finalMessage = round.text.length > 0 ? round.text : round.reasoning;
                turn.status = 'succeeded';
                turn.stepIds = steps.map((s) => s.stepId);
                await this.deps.memory.saveTurn(turn);
                return {
                    ok: true,
                    reason: 'final-answer',
                    steps,
                    finalMessage: finalMessage.length > 0 ? finalMessage : undefined,
                    accumulatedTokens,
                    accumulatedCostUsd,
                };
            }
            steps = steps.concat(roundSteps);
            await this.saveCheckpoint(turn, steps, accumulatedTokens, accumulatedCostUsd);
            roundIndex++;
            wantsContinue = steps.some((s) => s.kind === 'tool_call' && s.status === 'running');
            // 上一轮已把所有 tool_call 置为 ok/blocked，故循环退出条件依赖工具仍产出；
            // 为防死循环：仅当上一轮存在 tool_call 时继续请求模型
            wantsContinue = round.toolCalls.length > 0;
        }
        return finalize({
            ok: false,
            reason: 'max-steps',
            steps,
            error: this.err('max-steps', '达到 Turn 最大步数'),
        });
    }

    /** 依次尝试候选 Provider；成功返回 round，全部失败返回 undefined（已 emit provider.fallback） */
    private async callWithFallback(
        capacity: Capacity,
        sessionId: string,
        turnId: string,
        context: Parameters<LLMDriver['stream']>[0]['context'],
        at: number,
    ): Promise<RoundResult | undefined> {
        const candidates = this.deps.fallbackModels();
        const tried = new Set<string>();
        let lastError: Error | undefined;
        for (const candidate of candidates) {
            const providerId = candidate.model.providerId;
            if (tried.has(providerId)) {
                continue;
            }
            tried.add(providerId);
            if (capacity.model.providerId !== providerId) {
                // 故障转移：切换模型后重试本轮
                capacity.model = candidate.model;
                this.deps.bus.emit({
                    ...baseEvent('provider.fallback', sessionId, turnId),
                    attributes: {
                        'gen_ai.request.model': candidate.model.modelId,
                        'gen_ai.provider.name': providerId,
                    },
                    payload: { turnId, model: candidate.model },
                });
            }
            try {
                return await this.runRound(capacity, context, at);
            } catch (driverError) {
                lastError = driverError as Error;
                this.deps.bus.emit({
                    ...baseEvent('llm.response', sessionId, turnId),
                    attributes: { 'gen_ai.request.model': candidate.model.modelId },
                    payload: { error: (driverError as Error).message, retryable: true },
                });
            }
        }
        void lastError;
        return undefined;
    }

    private async runRound(
        capacity: Capacity,
        context: Parameters<LLMDriver['stream']>[0]['context'],
        at: number,
    ): Promise<RoundResult> {
        const events: LLMStreamEvent[] = [];
        for await (const e of this.deps
            .driverFor(capacity.model.providerId)
            .stream({ model: capacity.model, context })) {
            events.push(e);
        }
        const text: string[] = [];
        const reasoning: string[] = [];
        const toolCalls: RoundResult['toolCalls'] = [];
        let vendorUsage: VendorUsage | undefined;
        let finishReason: string | undefined;
        let ttftMs = 0;
        let firstTextAt: number | undefined;
        for (const e of events) {
            switch (e.type) {
                case 'text-delta':
                    if (firstTextAt === undefined) firstTextAt = this.now();
                    text.push(e.delta);
                    break;
                case 'reasoning-delta':
                    reasoning.push(e.delta);
                    break;
                case 'tool-call':
                    toolCalls.push(e);
                    break;
                case 'usage':
                    vendorUsage = e.usage;
                    break;
                case 'end':
                    finishReason = e.finishReason;
                    break;
            }
        }
        ttftMs = firstTextAt === undefined ? 0 : firstTextAt - at;
        return {
            text: text.join(''),
            reasoning: reasoning.join(''),
            toolCalls,
            vendorUsage,
            ttftMs,
            totalMs: this.now() - at,
            finishReason,
        };
    }

    private step(
        turn: Turn,
        sessionId: string,
        seq: number,
        kind: Step['kind'],
        payload: Step['payload'],
        capacity: Capacity,
        usage?: Usage,
    ): Step {
        return {
            stepId: ulid(),
            turnId: turn.turnId,
            sessionId,
            seq,
            kind,
            payload,
            model: capacity.model,
            usage,
            status: 'running',
            startedAt: this.now(),
            decisionContext: {
                contextSummary: '',
                promptVersion: this.deps.promptVersion,
                capturedAt: this.now(),
            },
        };
    }

    private observationStep(
        turn: Turn,
        sessionId: string,
        seq: number,
        toolName: string,
        result: ToolExecutionResult,
    ): Step {
        const obs: Step = {
            stepId: ulid(),
            turnId: turn.turnId,
            sessionId,
            seq,
            kind: 'observation',
            payload: result.ok
                ? { toolName, content: result.content }
                : { toolName, content: result.error, isError: true },
            status: 'ok',
            startedAt: this.now(),
            endedAt: this.now(),
        };
        return obs;
    }

    private async saveCheckpoint(
        turn: Turn,
        steps: Step[],
        tokens: TokenTotals,
        costUsd: number,
    ): Promise<void> {
        const completed = steps.filter((s) => s.status === 'ok');
        const pending = steps
            .filter((s) => s.status === 'running' || s.status === 'pending')
            .map((s) => s.stepId);
        turn.checkpoint = {
            lastCompletedStepSeq:
                completed.length > 0 ? Math.max(...completed.map((s) => s.seq)) : 0,
            pendingStepIds: pending,
            accumulatedUsage: tokens,
            accumulatedCostUsd: costUsd,
            savedAt: this.now(),
        };
        await this.deps.memory.saveCheckpoint(turn.turnId, turn.checkpoint);
    }

    private err(code: string, message: string, retryable = false): HarnessError {
        return { code, message, retryable };
    }

    private now(): number {
        return this.deps.now?.() ?? Date.now();
    }
}

/** 将 vendor usage 计数字段累计到 TokenTotals（账单口径） */
function addVendorTokens(target: TokenTotals, vendor: VendorUsage): void {
    target.input += vendor.inputTokens;
    target.output += vendor.outputTokens;
    target.cacheWrite += vendor.cacheCreationInputTokens ?? 0;
    target.cacheRead += vendor.cacheReadInputTokens ?? 0;
    target.reasoning += vendor.reasoningOutputTokens ?? 0;
}
