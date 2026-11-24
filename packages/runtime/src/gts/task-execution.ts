/**
 * goal-executor —— Task 执行（C3c 起步，C5-1 补全工具闭环）。
 * 复用 requestRound 执行面：模型轮 → 有 toolCalls →（白名单 → 工具调用 → 观察）→ 追加消息继续，
 * 无 toolCalls → 最终回答。Step 归因 taskId/goalId，全部经 GoalStore 持久化。
 */

import type { Goal, Step, StepAgentRole, StepKind, StepRole, Task, ToolSchema } from '@mazi/core';
import { ulid } from '@mazi/core';
import {
    type ContextContribution,
    ContextManager,
    EMPTY_SUCCESS_OUTPUT,
    formatToolObservation,
    type SecretRedactor,
} from '../harness/context-manager.js';
import type { GoalStore } from '../memory/goal-store.js';
import { decideFinalize } from './deterministic-finalize.js';
import { DEFAULT_GOAL_MAX_STEPS } from './plan-graph.js';
import type { ExecutorRoundContext, RoundResult, RoundToolCall } from './round-types.js';

export interface GoalToolInvoker {
    invoke(
        toolName: string,
        args: Record<string, unknown>,
        ctx?: { stepId?: string; taskId?: string },
    ): Promise<{
        ok: boolean;
        content: string;
        error?: string;
        /** 失败分类（错误层给出的 code，供 Step 归因与审计）。 */
        code?: string;
        /** 错误层结论：是否值得让调用方重试（同参/变参）。 */
        retryable?: boolean;
    }>;
}

export interface GoalExecutorDeps {
    store: GoalStore;
    requestRound: (ctx: ExecutorRoundContext) => Promise<RoundResult>;
    model?: { providerId: string; modelId: string };
    systemPrompt?: string;
    tools?: ToolSchema[];
    /** 工具执行器（缺省：任何 toolCall 都拒绝） */
    invoker?: GoalToolInvoker;
    /** Task 允许的工具白名单（缺省：全部允许） */
    allowedTools?: string[];
    /** 上下文贡献（记忆等），透传 ContextManager。 */
    contributions?: readonly ContextContribution[];
    /** 工作目录（工具实际执行目录；入库到 invocation payload.cwd 供展示/追溯） */
    workspaceRoot?: string;
    maxSteps?: number;
    /** 成本上限（USD）；每轮结束后累计 round.cost.totalCostUsd，超限即停 */
    maxCostUsd?: number;
    now?: () => number;
    /** Step 落库后即时回调（流式上报：思考/工具/观察），供事件总线实时推送给 UI */
    onStep?: (step: Step) => void;
    /** 按 StepKind 标注 workflow 节点角色；缺省不写 role（default loop / 轻量调用）。 */
    roleForStep?: (kind: StepKind) => StepRole | undefined;
    /** 写入实际 nodeRun / node / agent 归属；缺省不写（旧 loop 或轻量调用）。 */
    provenanceForStep?: (kind: StepKind) => {
        nodeRunId?: string;
        nodeId?: string;
        nodeRole?: StepRole;
        agentRole?: StepAgentRole;
    };
    /** 敏感内容进入 context 的断流端口（V3 机制二）；缺省时 secret 观察值 fail-closed */
    redactor?: SecretRedactor;
    /** 协作式停止信号：每个轮次开始前检查；模型调用透传到 provider 层。 */
    signal?: AbortSignal;
    /** 恢复执行：该 Task 已落库的 Step（按 startedAt 升序），用于重放上下文。 */
    resumeSteps?: readonly Step[];
    /** 在上下文窗口占用达到阈值时压缩完整工具轮（默认 0.9）。 */
    contextCompactThreshold?: number;
    /** Direct summaries from prerequisite Tasks, available even if memory recall is sparse. */
    precedingTaskResults?: readonly {
        title: string;
        finalMessage?: string;
        errorMessage?: string;
    }[];
}

function stepRoleOf(
    deps: GoalExecutorDeps,
    kind: StepKind,
): Partial<Pick<Step, 'role' | 'nodeRunId' | 'nodeId' | 'nodeRole' | 'agentRole'>> {
    const role = deps.roleForStep?.(kind);
    const provenance = deps.provenanceForStep?.(kind);
    return {
        ...(role !== undefined ? { role } : {}),
        ...(provenance?.nodeRunId !== undefined ? { nodeRunId: provenance.nodeRunId } : {}),
        ...(provenance?.nodeId !== undefined ? { nodeId: provenance.nodeId } : {}),
        ...(provenance?.nodeRole !== undefined ? { nodeRole: provenance.nodeRole } : {}),
        ...(provenance?.agentRole !== undefined ? { agentRole: provenance.agentRole } : {}),
    };
}

export type TaskStopReason =
    | 'final-answer'
    | 'max-steps'
    | 'budget-exceeded'
    | 'driver-error'
    | 'blocked-tool'
    | 'aborted';

/** 一个待补齐的调用：已终态者带 observation（复用），pending/active 者待执行。 */
interface ReplayCall {
    callId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    step?: Extract<Step, { kind: 'invocation' }>;
    observation?: { output: string; isError: boolean };
}

interface ReplayResult {
    rounds: number;
    lastCallKey?: string;
    /** 末轮未完成：assistant 已回注，待补齐 tool results（先执行 observation 缺省的调用）。 */
    openRound?: { calls: ReplayCall[] };
}

/**
 * 工具调用的最后防线：invoker 契约是"不抛"，但装配错误仍可能抛出。
 * 这里把抛出收敛成一条失败结果，任何工具异常都不得让 Task 直接失败。
 */
async function invokeSafely(
    invoker: GoalToolInvoker,
    toolName: string,
    args: Record<string, unknown>,
    ctx: { stepId?: string; taskId?: string },
): Promise<{ ok: boolean; content: string; error?: string; code?: string; retryable?: boolean }> {
    try {
        return await invoker.invoke(toolName, args, ctx);
    } catch (error) {
        return {
            ok: false,
            content: '',
            error: error instanceof Error ? error.message : String(error),
            code: 'EXECUTION_FAILED',
            retryable: false,
        };
    }
}

/** invocation 是否已到终态（pending/active 视为“已安排未执行”）。 */
function isTerminalInvocation(step: Extract<Step, { kind: 'invocation' }>): boolean {
    return step.status !== 'pending' && step.status !== 'active';
}

/**
 * 从已落库 Step 重放 Task 上下文：deliberation -> assistant(toolCalls)，紧随的
 * 终态 invocation 合并为一条 tool results；成功调用回填去重表，恢复后不重复执行。
 * 末轮若含 pending/active 调用，则只回注 assistant 并通过 openRound 交回调用方补齐。
 */
function replayPersistedSteps(
    context: ContextManager,
    steps: readonly Step[],
    executedCalls: Map<string, { output: string; isError: boolean }>,
): ReplayResult {
    let rounds = 0;
    let lastCallKey: string | undefined;
    let index = 0;
    while (index < steps.length) {
        const step = steps[index];
        if (step === undefined) break;
        if (step.kind !== 'deliberation') {
            index += 1;
            continue;
        }
        const toolCalls = step.payload.toolCalls ?? [];
        if (toolCalls.length === 0) {
            context.appendAssistant({ text: step.payload.answer ?? '', toolCalls: [] });
            index += 1;
            rounds += 1;
            lastCallKey = undefined;
            continue;
        }
        index += 1;
        const invocationByCallId = new Map<string, Extract<Step, { kind: 'invocation' }>>();
        while (index < steps.length) {
            const invocation = steps[index];
            if (invocation === undefined || invocation.kind !== 'invocation') break;
            if (invocation.payload.callId !== undefined) {
                invocationByCallId.set(invocation.payload.callId, invocation);
            }
            index += 1;
        }
        const calls: ReplayCall[] = toolCalls.map((call) => {
            const invocation = invocationByCallId.get(call.callId);
            const base: ReplayCall = {
                callId: call.callId,
                toolName: call.name,
                arguments: call.arguments,
                ...(invocation !== undefined ? { step: invocation } : {}),
            };
            if (invocation === undefined || !isTerminalInvocation(invocation)) return base;
            const isError = invocation.status !== 'succeeded';
            const output = invocation.payload.output ?? '';
            if (!isError) {
                executedCalls.set(`${call.name}:${JSON.stringify(call.arguments)}`, {
                    output: formatToolObservation(output, false),
                    isError: false,
                });
            }
            return { ...base, observation: { output, isError } };
        });
        const callKey = toolCalls
            .map((call) => `${call.name}:${JSON.stringify(call.arguments)}`)
            .join('|');
        // 末轮存在未完成调用：assistant 先回注，调用方执行后统一补一条 tool results。
        if (calls.some((call) => call.observation === undefined)) {
            context.appendAssistant({ text: step.payload.answer ?? '', toolCalls });
            return { rounds: rounds + 1, lastCallKey: callKey, openRound: { calls } };
        }
        context.appendAssistant({ text: step.payload.answer ?? '', toolCalls });
        context.appendToolResults(
            calls.map((call) => ({
                callId: call.callId,
                output: call.observation?.output ?? '',
                isError: call.observation?.isError === true,
            })),
        );
        rounds += 1;
        lastCallKey = callKey;
    }
    return { rounds, ...(lastCallKey !== undefined ? { lastCallKey } : {}) };
}

/**
 * 补齐 openRound：终态调用复用 observation，pending/active 调用逐个执行（每个执行前
 * 检查停止信号，被停止时剩余调用保持 pending）。返回合并后的 outputs 与是否被中断。
 */
async function completeOpenRound(
    deps: GoalExecutorDeps,
    task: Task,
    invoker: GoalToolInvoker,
    steps: Step[],
    executedCalls: Map<string, { output: string; isError: boolean }>,
    calls: readonly ReplayCall[],
): Promise<
    | { aborted: true }
    | {
          aborted: false;
          outputs: Array<{
              callId: string;
              toolName: string;
              output: string;
              isError: boolean;
              replayed: boolean;
          }>;
      }
> {
    const now = deps.now ?? Date.now;
    const outputs: Array<{
        callId: string;
        toolName: string;
        output: string;
        isError: boolean;
        replayed: boolean;
    }> = [];
    for (const call of calls) {
        if (call.observation !== undefined) {
            outputs.push({
                callId: call.callId,
                toolName: call.toolName,
                output: call.observation.output,
                isError: call.observation.isError,
                replayed: true,
            });
            continue;
        }
        if (deps.signal?.aborted === true) return { aborted: true };
        let toolStep = call.step;
        if (toolStep === undefined) {
            // 崩溃等异常场景：缺失 invocation 行时补建，保证执行事实落库。
            toolStep = {
                stepId: ulid(),
                taskId: task.taskId,
                goalId: task.goalId,
                ...stepRoleOf(deps, 'invocation'),
                kind: 'invocation',
                payload: {
                    toolName: call.toolName,
                    arguments: call.arguments,
                    callId: call.callId,
                    ...(deps.workspaceRoot !== undefined ? { cwd: deps.workspaceRoot } : {}),
                },
                status: 'pending',
                startedAt: now(),
            };
            steps.push(toolStep);
            await deps.store.saveStep(toolStep);
            deps.onStep?.(toolStep);
        }
        toolStep.status = 'active';
        toolStep.startedAt = now();
        await deps.store.saveStep(toolStep);
        deps.onStep?.(toolStep);
        const res = await invokeSafely(invoker, call.toolName, call.arguments, {
            stepId: toolStep.stepId,
            taskId: task.taskId,
        });
        const raw = res.ok ? res.content : (res.error ?? 'tool failed');
        const output = formatToolObservation(raw, !res.ok);
        const isError = !res.ok;
        executedCalls.set(`${call.toolName}:${JSON.stringify(call.arguments)}`, {
            output,
            isError,
        });
        outputs.push({
            callId: call.callId,
            toolName: call.toolName,
            output,
            isError,
            replayed: false,
        });
        toolStep.payload.output = output;
        toolStep.status = isError ? 'error' : 'succeeded';
        if (isError) {
            toolStep.error = {
                code: res.code ?? 'tool_error',
                message: output,
                source: 'tool',
                retryable: res.retryable ?? false,
            };
        }
        toolStep.endedAt = now();
        await deps.store.saveStep(toolStep);
        deps.onStep?.(toolStep);
    }
    return { aborted: false, outputs };
}

/** 重试收尾时把已成功的结果合成最终答案；全为空成功时给一句完成语。 */
function finalizeReplayedOutputs(outputs: readonly { output: string }[]): string {
    const distinct = [...new Set(outputs.map((item) => item.output))];
    if (distinct.length > 0 && distinct.every((text) => text === EMPTY_SUCCESS_OUTPUT)) {
        return '已完成（命令执行成功，无输出）。';
    }
    return distinct.join('\n\n');
}

export interface TaskOutcome {
    task: Task;
    steps: Step[];
    ok: boolean;
    reason: TaskStopReason;
    finalMessage?: string;
    errorMessage?: string;
}

type TaskTerminal = {
    ok: boolean;
    reason: TaskStopReason;
    finalMessage?: string;
    errorMessage?: string;
};

type InvocationStep = Extract<Step, { kind: 'invocation' }>;

interface TaskProposal {
    text: string;
    toolCalls: RoundToolCall[];
    callSteps: Map<string, InvocationStep>;
    round: number;
    contextWindow?: number;
}

export interface ActOutput {
    callId: string;
    toolName: string;
    output: string;
    isError: boolean;
    replayed: boolean;
}

type ReasonOutcome = 'tools' | 'final' | 'failed' | 'empty';
type ActOutcome = 'observed' | 'failed' | 'empty';
type ObserveOutcome = 'continue' | 'final' | 'failed';

/**
 * 一个 Task 的单步执行作用域。
 *
 * 它只做效果：一次模型轮、一次工具批、一次观察、一次收尾；不持有循环，不决定下一
 * 个 phase。调度与终止由 WorkflowRunner 统一负责。
 */
export class TaskExecutionContext {
    private readonly deps: GoalExecutorDeps;
    private readonly now: () => number;
    private readonly maxSteps: number;
    private readonly maxCostUsd: number | undefined;
    private readonly invoker: GoalToolInvoker | undefined;
    private readonly allowed: Set<string>;
    private readonly context: ContextManager;
    private readonly steps: Step[];
    private readonly executedCalls = new Map<string, { output: string; isError: boolean }>();
    private readonly replayed: ReplayResult;
    private spentUsd = 0;
    private roundIndex: number;
    private prevCallKey: string | undefined;
    private repeatCount = 0;
    private recoveryPending = false;
    private deliberationStep: Step | undefined;
    private proposal: TaskProposal | undefined;
    private outputs: ActOutput[] | undefined;
    private lastText = '';
    private lastToolCalls: RoundToolCall[] = [];
    private lastContextWindow: number | undefined;
    private terminalState: TaskTerminal | undefined;
    private finalMessage: string | undefined;
    private started = false;

    constructor(
        deps: GoalExecutorDeps,
        readonly task: Task,
        readonly goal: Goal,
    ) {
        this.deps = deps;
        this.now = deps.now ?? Date.now;
        this.maxSteps = deps.maxSteps ?? DEFAULT_GOAL_MAX_STEPS;
        this.maxCostUsd = deps.maxCostUsd;
        this.invoker = deps.invoker;
        this.allowed = new Set(deps.allowedTools ?? []);
        this.context = new ContextManager({
            ...(deps.systemPrompt !== undefined ? { systemPrompt: deps.systemPrompt } : {}),
            tools: deps.tools ?? [],
            contributions: deps.contributions ?? [],
            ...(deps.redactor !== undefined ? { redactor: deps.redactor } : {}),
        });
        this.context.appendUser(goal.statement);
        const preceding = (deps.precedingTaskResults ?? [])
            .map((item) => {
                const result = item.finalMessage ?? item.errorMessage ?? '（无最终输出）';
                return `- ${item.title}：${result.slice(0, 2000)}`;
            })
            .join('\n');
        const taskScope = [
            '## Current Task',
            `Goal：${goal.statement}`,
            `Task：${task.title}`,
            ...(preceding.length > 0 ? ['已完成的前置 Task：', preceding] : []),
            '只完成当前 Task；不要把后续 Task 提前执行。',
        ].join('\n');
        this.context.addContribution({ id: 'task-scope', systemPrompt: () => taskScope });
        this.steps = [...(deps.resumeSteps ?? [])];
        this.replayed = deps.resumeSteps
            ? replayPersistedSteps(this.context, deps.resumeSteps, this.executedCalls)
            : { rounds: 0 };
        this.roundIndex = this.replayed.rounds;
    }

    get isTerminal(): boolean {
        return this.terminalState !== undefined;
    }

    get isAwaitingVerify(): boolean {
        return this.finalMessage !== undefined;
    }

    get maxRoundCount(): number {
        return this.maxSteps;
    }

    get lastOutputs(): readonly ActOutput[] {
        return this.outputs ?? [];
    }

    outcome(): TaskOutcome {
        const terminal = this.terminalState;
        return {
            task: this.task,
            steps: this.steps,
            ok: terminal?.ok ?? this.finalMessage !== undefined,
            reason: terminal?.reason ?? 'final-answer',
            ...((terminal?.finalMessage ?? this.finalMessage) !== undefined
                ? { finalMessage: terminal?.finalMessage ?? this.finalMessage }
                : {}),
            ...(terminal?.errorMessage !== undefined
                ? { errorMessage: terminal.errorMessage }
                : {}),
        };
    }

    private async saveTask(): Promise<void> {
        if (
            this.task.status !== 'pending' &&
            this.task.status !== 'active' &&
            this.task.endedAt === undefined
        ) {
            this.task.endedAt = this.now();
        }
        await this.deps.store.saveTask(this.task);
    }

    private defaultRole(kind: StepKind): StepRole {
        return kind === 'deliberation' ? 'think' : 'act';
    }

    private defaultProvenance(
        kind: StepKind,
        round: number,
    ): {
        nodeRunId: string;
        nodeId: string;
        nodeRole: StepRole;
        agentRole: StepAgentRole;
    } {
        const node = kind === 'deliberation' ? 'think' : 'act';
        return {
            nodeRunId: `${node}:${this.task.taskId}:${round + 1}`,
            nodeId: node,
            nodeRole: node,
            agentRole: kind === 'deliberation' ? 'reasoner' : 'executor',
        };
    }

    private stepMeta(
        kind: StepKind,
        round: number,
    ): Partial<Pick<Step, 'role' | 'nodeRunId' | 'nodeId' | 'nodeRole' | 'agentRole'>> {
        const role = this.deps.roleForStep?.(kind) ?? this.defaultRole(kind);
        const provenance =
            this.deps.provenanceForStep?.(kind) ?? this.defaultProvenance(kind, round);
        return { role, ...provenance };
    }

    private effectiveDeps(round: number): GoalExecutorDeps {
        return {
            ...this.deps,
            roleForStep: (kind) => this.stepMeta(kind, round).role,
            provenanceForStep: (kind) => {
                const meta = this.stepMeta(kind, round);
                return {
                    ...(meta.nodeRunId !== undefined ? { nodeRunId: meta.nodeRunId } : {}),
                    ...(meta.nodeId !== undefined ? { nodeId: meta.nodeId } : {}),
                    ...(meta.nodeRole !== undefined ? { nodeRole: meta.nodeRole } : {}),
                    ...(meta.agentRole !== undefined ? { agentRole: meta.agentRole } : {}),
                };
            },
        };
    }

    private stopRequested(): boolean {
        return this.deps.signal?.aborted === true;
    }

    private async fail(reason: TaskStopReason, errorMessage?: string): Promise<void> {
        if (this.terminalState !== undefined) return;
        this.task.status = reason === 'aborted' ? 'aborted' : 'failed';
        this.terminalState = {
            ok: false,
            reason,
            ...(errorMessage !== undefined ? { errorMessage } : {}),
        };
        await this.saveTask();
    }

    private async markFinal(finalMessage: string): Promise<void> {
        this.finalMessage = finalMessage;
    }

    async start(): Promise<void> {
        if (this.started) return;
        this.started = true;
        this.task.startedAt ??= this.now();
        this.task.status = 'active';
        this.task.endedAt = undefined;
        await this.saveTask();

        const openRound = this.replayed.openRound;
        if (openRound === undefined) return;
        if (this.invoker === undefined) {
            await this.fail('blocked-tool', '未装配工具执行器（invoker 缺省拒绝所有工具）');
            return;
        }
        const completion = await completeOpenRound(
            this.effectiveDeps(this.roundIndex),
            this.task,
            this.invoker,
            this.steps,
            this.executedCalls,
            openRound.calls,
        );
        if (completion.aborted) {
            await this.fail('aborted');
            return;
        }
        this.context.appendToolResults(
            completion.outputs.map((item) => ({
                callId: item.callId,
                output: item.output,
                isError: item.isError,
            })),
        );
    }

    private async requestRound(): Promise<RoundResult> {
        const systemPrompt = this.context.systemPrompt();
        return this.deps.requestRound({
            goalId: this.task.goalId,
            taskId: this.task.taskId,
            model: this.deps.model ?? { providerId: 'default', modelId: 'default' },
            messages: this.context.messages(),
            baseMessageCount: this.context.baseMessageCount(),
            ...(systemPrompt !== undefined ? { systemPrompt } : {}),
            tools: this.context.tools(),
            context: this.context,
            ...(this.deps.signal !== undefined ? { signal: this.deps.signal } : {}),
        });
    }

    /** 一次 LLM 推理。 */
    async reason(): Promise<ReasonOutcome> {
        if (this.terminalState !== undefined) return 'failed';
        if (this.stopRequested()) {
            await this.fail('aborted');
            return 'failed';
        }
        if (this.maxCostUsd !== undefined && this.spentUsd >= this.maxCostUsd) {
            await this.fail(
                'budget-exceeded',
                `达到成本上限 $${this.maxCostUsd}（已花费 $${this.spentUsd.toFixed(4)}）`,
            );
            return 'failed';
        }
        if (this.roundIndex >= this.maxSteps) {
            await this.fail('max-steps', '达到 Task 最大轮次');
            return 'failed';
        }

        const round = this.roundIndex;
        let result: RoundResult;
        try {
            result = await this.requestRound();
        } catch (error) {
            if (this.stopRequested()) await this.fail('aborted');
            else
                await this.fail(
                    'driver-error',
                    error instanceof Error ? error.message : String(error),
                );
            return 'failed';
        }
        const generationMs = result.totalMs - result.ttftMs;
        const roundEndedAt = this.now();
        const roundStartedAt = roundEndedAt - Math.max(0, result.totalMs ?? 0);
        const outputTokens = result.vendorUsage?.outputTokens ?? 0;
        const hasRoundFacts =
            result.vendorUsage !== undefined ||
            result.raw !== undefined ||
            result.pin !== undefined ||
            result.contextUsage !== undefined ||
            result.estimate !== undefined ||
            result.output !== undefined ||
            result.pricing !== undefined ||
            result.cost !== undefined;
        const roundUsage = hasRoundFacts
            ? {
                  ...(result.vendorUsage !== undefined ? { vendor: result.vendorUsage } : {}),
                  ...(result.raw !== undefined ? { raw: result.raw } : {}),
                  ...(result.pin !== undefined ? { pin: result.pin } : {}),
                  ...(result.contextUsage !== undefined ? { runtime: result.contextUsage } : {}),
                  ...(result.estimate !== undefined ? { estimate: result.estimate } : {}),
                  ...(result.output !== undefined ? { output: result.output } : {}),
                  ...(result.pricing !== undefined ? { pricing: result.pricing } : {}),
                  ...(result.cost !== undefined ? { cost: result.cost } : {}),
                  ...(result.estimatedCost !== undefined
                      ? { estimatedCost: result.estimatedCost }
                      : {}),
                  timing: {
                      ttftMs: result.ttftMs,
                      totalMs: result.totalMs,
                      tokensPerSecond:
                          outputTokens > 0 && generationMs > 0
                              ? (outputTokens / generationMs) * 1000
                              : 0,
                  },
              }
            : undefined;
        const roundId = ulid();
        const roundUsageWithId = roundUsage ? { ...roundUsage, roundId } : undefined;
        this.spentUsd += result.cost?.totalCostUsd ?? result.estimatedCost?.totalCostUsd ?? 0;
        this.lastText = result.text;
        this.lastToolCalls = result.toolCalls;
        this.lastContextWindow = result.contextUsage?.contextWindowTokens;

        const hasDeliberation =
            result.reasoning.length > 0 || result.text.length > 0 || result.toolCalls.length > 0;
        if (hasDeliberation) {
            const deliberation: Step = {
                stepId: ulid(),
                taskId: this.task.taskId,
                goalId: this.task.goalId,
                ...this.stepMeta('deliberation', round),
                kind: 'deliberation',
                payload: {
                    ...(result.reasoning.length > 0 ? { thinking: result.reasoning } : {}),
                    ...(result.text.length > 0 ? { answer: result.text } : {}),
                    ...(result.toolCalls.length > 0
                        ? {
                              toolCalls: result.toolCalls.map((call) => ({
                                  callId: call.callId,
                                  name: call.toolName,
                                  arguments: call.arguments,
                              })),
                          }
                        : {}),
                },
                status: 'succeeded',
                startedAt: roundStartedAt,
                endedAt: roundEndedAt,
                ...(roundUsageWithId !== undefined ? { usage: roundUsageWithId } : {}),
            };
            this.deliberationStep = deliberation;
            this.steps.push(deliberation);
            await this.deps.store.saveStep(deliberation);
            this.deps.onStep?.(deliberation);
        }

        if (result.toolCalls.length === 0) {
            this.roundIndex = round + 1;
            await this.markFinal(result.text);
            return 'final';
        }

        if (this.invoker === undefined) {
            await this.fail('blocked-tool', '未装配工具执行器（invoker 缺省拒绝所有工具）');
            return 'failed';
        }

        const callKey = result.toolCalls
            .map((call) => `${call.toolName}:${JSON.stringify(call.arguments)}`)
            .join('|');
        this.repeatCount = callKey === this.prevCallKey ? this.repeatCount + 1 : 0;
        this.prevCallKey = callKey;
        if (this.repeatCount >= 3) {
            const final = result.text.trim().length > 0 ? result.text : '已完成。';
            if (this.deliberationStep?.kind === 'deliberation') {
                this.deliberationStep.payload.answer = final;
                await this.deps.store.saveStep(this.deliberationStep);
                this.deps.onStep?.(this.deliberationStep);
            }
            this.roundIndex = round + 1;
            await this.markFinal(final);
            return 'final';
        }

        const blocked = result.toolCalls.find(
            (call) => this.allowed.size > 0 && !this.allowed.has(call.toolName),
        );
        if (blocked !== undefined) {
            const step: InvocationStep = {
                stepId: ulid(),
                taskId: this.task.taskId,
                goalId: this.task.goalId,
                ...this.stepMeta('invocation', round),
                kind: 'invocation',
                payload: {
                    toolName: blocked.toolName,
                    arguments: blocked.arguments,
                    callId: blocked.callId,
                    ...(this.deps.workspaceRoot !== undefined
                        ? { cwd: this.deps.workspaceRoot }
                        : {}),
                },
                status: 'blocked',
                error: {
                    code: 'tool_blocked',
                    message: `工具被策略拦截：${blocked.toolName}`,
                    source: 'policy',
                    retryable: false,
                },
                startedAt: this.now(),
                endedAt: this.now(),
            };
            this.steps.push(step);
            await this.deps.store.saveStep(step);
            this.deps.onStep?.(step);
            this.roundIndex = round + 1;
            await this.fail('blocked-tool', `工具被策略拦截：${blocked.toolName}`);
            return 'failed';
        }

        const callSteps = new Map<string, InvocationStep>();
        for (const call of result.toolCalls) {
            const step: InvocationStep = {
                stepId: ulid(),
                taskId: this.task.taskId,
                goalId: this.task.goalId,
                ...this.stepMeta('invocation', round),
                kind: 'invocation',
                payload: {
                    toolName: call.toolName,
                    arguments: call.arguments,
                    callId: call.callId,
                    ...(this.deps.workspaceRoot !== undefined
                        ? { cwd: this.deps.workspaceRoot }
                        : {}),
                },
                status: 'pending',
                startedAt: this.now(),
            };
            callSteps.set(call.callId, step);
            this.steps.push(step);
            await this.deps.store.saveStep(step);
            this.deps.onStep?.(step);
        }
        this.proposal = {
            text: result.text,
            toolCalls: result.toolCalls,
            callSteps,
            round,
            ...(this.lastContextWindow !== undefined
                ? { contextWindow: this.lastContextWindow }
                : {}),
        };
        this.roundIndex = round + 1;
        return 'tools';
    }

    /** 执行上一轮推理产出的工具批，不调用模型。 */
    async act(): Promise<ActOutcome> {
        if (this.terminalState !== undefined) return 'failed';
        const proposal = this.proposal;
        if (proposal === undefined) return 'empty';
        this.proposal = undefined;
        if (this.invoker === undefined) {
            await this.fail('blocked-tool', '未装配工具执行器（invoker 缺省拒绝所有工具）');
            return 'failed';
        }
        const outputs: ActOutput[] = [];
        for (const call of proposal.toolCalls) {
            if (this.stopRequested()) {
                await this.fail('aborted');
                return 'failed';
            }
            const step = proposal.callSteps.get(call.callId);
            if (step === undefined) continue;
            step.status = 'active';
            step.startedAt = this.now();
            await this.deps.store.saveStep(step);
            this.deps.onStep?.(step);

            const cacheKey = `${call.toolName}:${JSON.stringify(call.arguments)}`;
            const cached = this.executedCalls.get(cacheKey);
            let output: string;
            let isError: boolean;
            let replayed = false;
            let code: string | undefined;
            let retryable = false;
            if (cached !== undefined && !cached.isError) {
                output = cached.output;
                isError = false;
                replayed = true;
            } else {
                const res = await invokeSafely(this.invoker, call.toolName, call.arguments, {
                    stepId: step.stepId,
                    taskId: this.task.taskId,
                });
                const raw = res.ok ? res.content : (res.error ?? 'tool failed');
                output = formatToolObservation(raw, !res.ok);
                isError = !res.ok;
                code = res.code;
                retryable = res.retryable ?? false;
                this.executedCalls.set(cacheKey, { output, isError });
            }
            outputs.push({
                callId: call.callId,
                toolName: call.toolName,
                output,
                isError,
                replayed,
            });
            step.payload.output = output;
            step.status = isError ? 'error' : 'succeeded';
            if (isError) {
                step.error = {
                    code: code ?? 'tool_error',
                    message: output,
                    source: 'tool',
                    retryable,
                };
            }
            step.endedAt = this.now();
            await this.deps.store.saveStep(step);
            this.deps.onStep?.(step);
        }
        this.outputs = outputs;
        return outputs.length > 0 ? 'observed' : 'empty';
    }

    /** 工具结果回注上下文，并判定确定性收尾。 */
    async observe(): Promise<ObserveOutcome> {
        if (this.terminalState !== undefined) return 'failed';
        const outputs = this.outputs ?? [];
        this.outputs = undefined;
        if (outputs.length === 0) return 'continue';

        if (outputs.some((item) => item.isError)) this.recoveryPending = true;
        else if (outputs.some((item) => !item.replayed)) this.recoveryPending = false;

        const decision = decideFinalize(this.lastText, outputs);
        if (decision !== undefined && this.deliberationStep?.kind === 'deliberation') {
            this.deliberationStep.payload.answer = decision.finalMessage;
            this.deliberationStep.payload.answerTemplate = this.lastText;
            await this.deps.store.saveStep(this.deliberationStep);
            this.deps.onStep?.(this.deliberationStep);
            await this.markFinal(decision.finalMessage);
            return 'final';
        }

        if (
            outputs.length > 0 &&
            outputs.every((item) => item.replayed) &&
            !this.recoveryPending &&
            this.lastText.trim().length === 0
        ) {
            const final = finalizeReplayedOutputs(outputs);
            if (this.deliberationStep?.kind === 'deliberation') {
                this.deliberationStep.payload.answer = final;
                await this.deps.store.saveStep(this.deliberationStep);
                this.deps.onStep?.(this.deliberationStep);
            }
            await this.markFinal(final);
            return 'final';
        }

        this.context.appendAssistant({
            text: this.lastText,
            toolCalls: this.lastToolCalls.map((call) => ({
                callId: call.callId,
                name: call.toolName,
                arguments: call.arguments,
            })),
        });
        this.context.appendToolResults(
            outputs.map((item) => ({
                callId: item.callId,
                output: item.output,
                isError: item.isError,
            })),
        );
        if (
            this.lastContextWindow !== undefined &&
            this.lastContextWindow > 0 &&
            this.context.shouldCompact(
                this.lastContextWindow,
                this.deps.contextCompactThreshold ?? 0.9,
            )
        ) {
            this.context.compactHistory();
        }
        return 'continue';
    }

    async finishSuccess(): Promise<void> {
        if (this.terminalState !== undefined) return;
        this.task.status = 'succeeded';
        await this.saveTask();
    }

    /** 由 dynamic verify 节点判定验收后回写 Task 状态。 */
    async applyAcceptance(status: Task['status']): Promise<void> {
        this.task.status = status;
        await this.saveTask();
    }
}
