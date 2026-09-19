/**
 * goal-executor —— Task 执行（C3c 起步，C5-1 补全工具闭环）。
 * 复用 requestRound 执行面：模型轮 → 有 toolCalls →（白名单 → 工具调用 → 观察）→ 追加消息继续，
 * 无 toolCalls → 最终回答。Step 归因 taskId/goalId，全部经 GoalStore 持久化。
 */

import type { Goal, Step, Task, ToolSchema } from '@mazi/core';
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
import type { ExecutorRoundContext, RoundResult } from './round-types.js';

export interface GoalToolInvoker {
    invoke(
        toolName: string,
        args: Record<string, unknown>,
        ctx?: { stepId?: string; taskId?: string },
    ): Promise<{
        ok: boolean;
        content: string;
        error?: string;
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
    now?: () => number;
    /** Step 落库后即时回调（流式上报：思考/工具/观察），供事件总线实时推送给 UI */
    onStep?: (step: Step) => void;
    /** 敏感内容进入 context 的断流端口（V3 机制二）；缺省时 secret 观察值 fail-closed */
    redactor?: SecretRedactor;
    /** 协作式停止信号：每个轮次开始前检查；模型调用透传到 provider 层。 */
    signal?: AbortSignal;
    /** 恢复执行：该 Task 已落库的 Step（按 startedAt 升序），用于重放上下文。 */
    resumeSteps?: readonly Step[];
}

export type TaskStopReason =
    | 'final-answer'
    | 'max-steps'
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
        const res = await invoker.invoke(call.toolName, call.arguments, {
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
                code: 'tool_error',
                message: output,
                source: 'tool',
                retryable: false,
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

export async function executeTask(
    deps: GoalExecutorDeps,
    task: Task,
    goal: Goal,
): Promise<TaskOutcome> {
    const now = deps.now ?? Date.now;
    // Task 生命周期时间：进入 active 记 startedAt，进入终态记 endedAt。
    task.startedAt ??= now();
    const saveTask = async (): Promise<void> => {
        if (task.status !== 'pending' && task.status !== 'active' && task.endedAt === undefined) {
            task.endedAt = now();
        }
        await deps.store.saveTask(task);
    };
    // 真实模型对项目类任务往往需要多轮工具调用后才收敛，默认上限放宽到 50
    const maxSteps = deps.maxSteps ?? 50;
    const invoker = deps.invoker;
    /** 协作式停止是否已触发（函数调用避免 TS 对 deps.signal 的过度收窄）。 */
    const stopRequested = (): boolean => deps.signal?.aborted === true;
    const allowed = new Set(deps.allowedTools ?? []);
    const context = new ContextManager({
        ...(deps.systemPrompt !== undefined ? { systemPrompt: deps.systemPrompt } : {}),
        tools: deps.tools ?? [],
        contributions: deps.contributions ?? [],
        ...(deps.redactor !== undefined ? { redactor: deps.redactor } : {}),
    });
    context.appendUser(goal.statement);
    // 恢复执行时 steps 从历史开始累积，使 outcome 携带完整执行事实（memory 写入用）。
    const steps: Step[] = [...(deps.resumeSteps ?? [])];
    // 已成功执行过的调用（tool+args 指纹 → 结果）：重复调用不再真正执行，避免空结果重试循环
    const executedCalls = new Map<string, { output: string; isError: boolean }>();
    // 恢复执行：把已落库 Step 重放回上下文，并从已完成的轮次继续计数。
    const replayed: ReplayResult = deps.resumeSteps
        ? replayPersistedSteps(context, deps.resumeSteps, executedCalls)
        : { rounds: 0 };

    // Persist the task before the first round. Live observers rebuild the tree via
    // GoalStore.listTasks(); without an early row the task (and all its in-progress
    // steps) stays invisible to /timeline until the task finishes.
    task.status = 'active';
    task.endedAt = undefined;
    await saveTask();

    const roundRequest = (): Promise<RoundResult> => {
        const systemPrompt = context.systemPrompt();
        return deps.requestRound({
            goalId: task.goalId,
            taskId: task.taskId,
            model: deps.model ?? { providerId: 'default', modelId: 'default' },
            messages: context.messages(),
            baseMessageCount: context.baseMessageCount(),
            ...(systemPrompt !== undefined ? { systemPrompt } : {}),
            tools: context.tools(),
            context,
            ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
        });
    };

    // 死循环护栏：连续相同工具调用达 3 轮视为未收敛（不烧完剩余轮次）
    let prevCallKey: string | undefined = replayed.lastCallKey;
    let repeatCount = 0;
    // 本轮的 deliberation step 引用；确定性收尾时回填渲染后的最终答案
    let deliberationStep: Step | undefined;

    try {
        // 恢复：末轮有待执行调用时先补齐（每个调用前检查停止信号），保持 tool results 完整。
        if (replayed.openRound !== undefined) {
            if (invoker === undefined) {
                task.status = 'failed';
                await saveTask();
                return {
                    task,
                    steps,
                    ok: false,
                    reason: 'blocked-tool',
                    errorMessage: '未装配工具执行器（invoker 缺省拒绝所有工具）',
                };
            }
            const completion = await completeOpenRound(
                deps,
                task,
                invoker,
                steps,
                executedCalls,
                replayed.openRound.calls,
            );
            if (completion.aborted) {
                task.status = 'aborted';
                await saveTask();
                return { task, steps, ok: false, reason: 'aborted' };
            }
            context.appendToolResults(
                completion.outputs.map((item) => ({
                    callId: item.callId,
                    output: item.output,
                    isError: item.isError,
                })),
            );
        }
        for (let roundIndex = replayed.rounds; roundIndex < maxSteps; roundIndex += 1) {
            // 协作式停止：轮次开始前检查，checkpoint 是上一轮的全部 Step。
            if (stopRequested()) {
                task.status = 'aborted';
                await saveTask();
                return { task, steps, ok: false, reason: 'aborted' };
            }
            const round = await roundRequest();

            // 一轮 usage 归属：模型生成本轮的 deliberation step，携带 roundId；
            // 审计聚合按 roundId 去重，保证一轮总量只计一次。
            const generationMs = round.totalMs - round.ttftMs;
            // 模型轮的真实起止：step.startedAt/endedAt 反映实际调用窗口（totalMs 来自 provider metrics）
            const roundEndedAt = now();
            const roundStartedAt = roundEndedAt - Math.max(0, round.totalMs ?? 0);
            const outputTokens = round.vendorUsage?.outputTokens ?? 0;
            const hasRoundFacts =
                round.vendorUsage !== undefined ||
                round.raw !== undefined ||
                round.pin !== undefined ||
                round.contextUsage !== undefined ||
                round.estimate !== undefined ||
                round.output !== undefined ||
                round.pricing !== undefined ||
                round.cost !== undefined;
            const roundUsage = hasRoundFacts
                ? {
                      ...(round.vendorUsage !== undefined ? { vendor: round.vendorUsage } : {}),
                      // 原始事实：入库优先，展示/计价可在读取时从它重算
                      ...(round.raw !== undefined ? { raw: round.raw } : {}),
                      ...(round.pin !== undefined ? { pin: round.pin } : {}),
                      ...(round.contextUsage !== undefined ? { runtime: round.contextUsage } : {}),
                      ...(round.estimate !== undefined ? { estimate: round.estimate } : {}),
                      ...(round.output !== undefined ? { output: round.output } : {}),
                      ...(round.pricing !== undefined ? { pricing: round.pricing } : {}),
                      ...(round.cost !== undefined ? { cost: round.cost } : {}),
                      ...(round.estimatedCost !== undefined
                          ? { estimatedCost: round.estimatedCost }
                          : {}),
                      timing: {
                          ttftMs: round.ttftMs,
                          totalMs: round.totalMs,
                          tokensPerSecond:
                              outputTokens > 0 && generationMs > 0
                                  ? (outputTokens / generationMs) * 1000
                                  : 0,
                      },
                  }
                : undefined;
            const roundId = ulid();
            const roundUsageWithId = roundUsage ? { ...roundUsage, roundId } : undefined;
            // deliberation step: 本轮一次模型输出（推理 + 回答 + 提议的工具调用）。
            // usage 归模型生成，挂在这一步；Invocation 步骤不承载 usage。
            const hasDeliberation =
                round.reasoning.length > 0 || round.text.length > 0 || round.toolCalls.length > 0;
            const attachUsage = (step: Step) => {
                if (step.usage !== undefined || roundUsageWithId === undefined) return;
                if (step.kind === 'deliberation') {
                    step.usage = roundUsageWithId;
                }
            };

            if (hasDeliberation) {
                const deliberation: Step = {
                    stepId: ulid(),
                    taskId: task.taskId,
                    goalId: task.goalId,
                    kind: 'deliberation',
                    payload: {
                        ...(round.reasoning.length > 0 ? { thinking: round.reasoning } : {}),
                        ...(round.text.length > 0 ? { answer: round.text } : {}),
                        ...(round.toolCalls.length > 0
                            ? {
                                  toolCalls: round.toolCalls.map((c) => ({
                                      callId: c.callId,
                                      name: c.toolName,
                                      arguments: c.arguments,
                                  })),
                              }
                            : {}),
                    },
                    status: 'succeeded',
                    startedAt: roundStartedAt,
                    endedAt: roundEndedAt,
                };
                attachUsage(deliberation);
                steps.push(deliberation);
                await deps.store.saveStep(deliberation);
                deps.onStep?.(deliberation);
                deliberationStep = deliberation;
            }

            if (round.toolCalls.length === 0) {
                task.status = 'succeeded';
                await saveTask();
                return {
                    task,
                    steps,
                    ok: true,
                    reason: 'final-answer',
                    ...(round.text.length > 0 ? { finalMessage: round.text } : {}),
                };
            }

            if (!invoker) {
                task.status = 'failed';
                await saveTask();
                return {
                    task,
                    steps,
                    ok: false,
                    reason: 'blocked-tool',
                    errorMessage: '未装配工具执行器（invoker 缺省拒绝所有工具）',
                };
            }

            // 防死循环：连续相同工具调用未收敛则中止（含调用签名一致判定）
            if (round.toolCalls.length > 0) {
                const callKey = round.toolCalls
                    .map((c) => `${c.toolName}:${JSON.stringify(c.arguments)}`)
                    .join('|');
                repeatCount = callKey === prevCallKey ? repeatCount + 1 : 0;
                prevCallKey = callKey;
                if (repeatCount >= 3) {
                    // 不再把未收敛当失败：以模型本轮文本（若有）收尾，避免无限重试
                    const finalMessage = round.text.trim().length > 0 ? round.text : '已完成。';
                    if (
                        deliberationStep !== undefined &&
                        deliberationStep.kind === 'deliberation'
                    ) {
                        deliberationStep.payload.answer = finalMessage;
                        await deps.store.saveStep(deliberationStep);
                        deps.onStep?.(deliberationStep);
                    }
                    task.status = 'succeeded';
                    await saveTask();
                    return { task, steps, ok: true, reason: 'final-answer', finalMessage };
                }
            }

            // 白名单检查：违规工具整轮拒绝（先拦后停，policy 语义）
            const blocked = round.toolCalls.find(
                (c) => allowed.size > 0 && !allowed.has(c.toolName),
            );
            if (blocked !== undefined) {
                const callStep: Step = {
                    stepId: ulid(),
                    taskId: task.taskId,
                    goalId: task.goalId,
                    kind: 'invocation',
                    payload: {
                        toolName: blocked.toolName,
                        arguments: blocked.arguments,
                        callId: blocked.callId,
                        ...(deps.workspaceRoot !== undefined ? { cwd: deps.workspaceRoot } : {}),
                    },
                    status: 'blocked',
                    error: {
                        code: 'tool_blocked',
                        message: `工具被策略拦截：${blocked.toolName}`,
                        source: 'policy',
                        retryable: false,
                    },
                    startedAt: now(),
                    endedAt: now(),
                };
                attachUsage(callStep);
                steps.push(callStep);
                await deps.store.saveStep(callStep);
                deps.onStep?.(callStep);
                task.status = 'failed';
                await saveTask();
                return {
                    task,
                    steps,
                    ok: false,
                    reason: 'blocked-tool',
                    errorMessage: `工具被策略拦截：${blocked.toolName}`,
                };
            }

            // 先落库本轮全部 invocation step（status=pending）：这些是「已安排未执行」的步骤，
            // 停止时保留、恢复时续跑；模型本轮工具提议见 deliberation.toolCalls。
            const callSteps = new Map<string, Extract<Step, { kind: 'invocation' }>>();
            for (const call of round.toolCalls) {
                const pendingStep: Extract<Step, { kind: 'invocation' }> = {
                    stepId: ulid(),
                    taskId: task.taskId,
                    goalId: task.goalId,
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
                callSteps.set(call.callId, pendingStep);
                steps.push(pendingStep);
                await deps.store.saveStep(pendingStep);
                deps.onStep?.(pendingStep);
            }

            // 执行工具：每个调用前检查停止信号，未开始者保持 pending（step 级可中断）。
            const outputs: Array<{
                callId: string;
                toolName: string;
                output: string;
                isError: boolean;
                replayed: boolean;
            }> = [];
            for (const call of round.toolCalls) {
                if (stopRequested()) {
                    task.status = 'aborted';
                    await saveTask();
                    return { task, steps, ok: false, reason: 'aborted' };
                }
                const toolStep = callSteps.get(call.callId);
                if (toolStep === undefined) continue;
                toolStep.status = 'active';
                toolStep.startedAt = now();
                await deps.store.saveStep(toolStep);
                deps.onStep?.(toolStep);

                const callKey = `${call.toolName}:${JSON.stringify(call.arguments)}`;
                const cached = executedCalls.get(callKey);
                let output: string;
                let isError: boolean;
                let replayed = false;
                if (cached !== undefined && !cached.isError) {
                    // 同一调用此前已成功：不重复执行，直接把已有结果回给模型
                    output = cached.output;
                    isError = false;
                    replayed = true;
                } else {
                    const res = await invoker.invoke(call.toolName, call.arguments, {
                        stepId: toolStep.stepId,
                        taskId: task.taskId,
                    });
                    const raw = res.ok ? res.content : (res.error ?? 'tool failed');
                    output = formatToolObservation(raw, !res.ok);
                    isError = !res.ok;
                    executedCalls.set(callKey, { output, isError });
                }
                outputs.push({
                    callId: call.callId,
                    toolName: call.toolName,
                    output,
                    isError,
                    replayed,
                });
                // 执行结果合并回 invocation step；失败以 StepError（四源标签 tool）表达，
                // 不在 payload 上再设 isError/structured。
                toolStep.payload.output = output;
                toolStep.status = isError ? 'error' : 'succeeded';
                if (isError) {
                    toolStep.error = {
                        code: 'tool_error',
                        message: output,
                        source: 'tool',
                        retryable: false,
                    };
                }
                toolStep.endedAt = now();
                await deps.store.saveStep(toolStep);
                deps.onStep?.(toolStep);
            }

            // 确定性收尾：模型同轮给出答案模板 + 工具调用，且全部成功、占位符可填满时，
            // 直接用模板与结果渲染最终答案，不再请求 LLM。
            const decision = decideFinalize(round.text, outputs);
            if (
                decision !== undefined &&
                deliberationStep !== undefined &&
                deliberationStep.kind === 'deliberation'
            ) {
                deliberationStep.payload.answer = decision.finalMessage;
                deliberationStep.payload.answerTemplate = round.text;
                await deps.store.saveStep(deliberationStep);
                deps.onStep?.(deliberationStep);
                task.status = 'succeeded';
                await saveTask();
                return {
                    task,
                    steps,
                    ok: true,
                    reason: 'final-answer',
                    finalMessage: decision.finalMessage,
                };
            }

            // 重试收尾：本轮全是“此前已成功”的重复调用且模型没有文本时，用已有结果收尾，
            // 杜绝 [ok] (no output) 之后反复重试的循环。
            if (
                outputs.length > 0 &&
                outputs.every((item) => item.replayed) &&
                round.text.trim().length === 0
            ) {
                const finalMessage = finalizeReplayedOutputs(outputs);
                if (deliberationStep !== undefined && deliberationStep.kind === 'deliberation') {
                    deliberationStep.payload.answer = finalMessage;
                    await deps.store.saveStep(deliberationStep);
                    deps.onStep?.(deliberationStep);
                }
                task.status = 'succeeded';
                await saveTask();
                return { task, steps, ok: true, reason: 'final-answer', finalMessage };
            }

            // 回注：assistant toolCalls + tool 结果消息；模型本轮文本一并回注（截断防爆上下文），
            // 避免模型在后续轮次“失忆”而重复发起相同工具调用。secret 观察值经 ContextManager 断流。
            context.appendAssistant({
                text: round.text,
                toolCalls: round.toolCalls.map((c) => ({
                    callId: c.callId,
                    name: c.toolName,
                    arguments: c.arguments,
                })),
            });
            context.appendToolResults(
                outputs.map((o) => ({
                    callId: o.callId,
                    output: o.output,
                    isError: o.isError,
                })),
            );
        }
        task.status = 'failed';
        await saveTask();
        return { task, steps, ok: false, reason: 'max-steps', errorMessage: '达到 Task 最大轮次' };
    } catch (error) {
        // 停止信号触发的模型/流式中断归为 aborted（可恢复），不记为 driver-error。
        if (stopRequested()) {
            task.status = 'aborted';
            await saveTask();
            return { task, steps, ok: false, reason: 'aborted' };
        }
        task.status = 'failed';
        await saveTask();
        return {
            task,
            steps,
            ok: false,
            reason: 'driver-error',
            ...(error instanceof Error ? { errorMessage: error.message } : {}),
        };
    }
}
