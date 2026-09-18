/**
 * goal-executor —— Task 执行（C3c 起步，C5-1 补全工具闭环）。
 * 复用 requestRound 执行面：模型轮 → 有 toolCalls →（白名单 → 工具调用 → 观察）→ 追加消息继续，
 * 无 toolCalls → 最终回答。Step 归因 taskId/goalId，全部经 GoalStore 持久化。
 */

import type { Goal, LLMMessage, Step, Task, ToolSchema } from '@mazi/core';
import { ulid } from '@mazi/core';
import { ContextManager, type SecretRedactor } from '../harness/context-manager.js';
import type { GoalStore } from '../memory/goal-store.js';
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
    /** Conversation 共享上下文：本轮任务前置的历史消息 */
    history?: LLMMessage[];
    /** 工作目录（工具实际执行目录；入库到 invocation payload.cwd 供展示/追溯） */
    workspaceRoot?: string;
    maxSteps?: number;
    now?: () => number;
    /** Step 落库后即时回调（流式上报：思考/工具/观察），供事件总线实时推送给 UI */
    onStep?: (step: Step) => void;
    /** 敏感内容进入 context 的断流端口（V3 机制二）；缺省时 secret 观察值 fail-closed */
    redactor?: SecretRedactor;
}

export type TaskStopReason = 'final-answer' | 'max-steps' | 'driver-error' | 'blocked-tool';

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
    const allowed = new Set(deps.allowedTools ?? []);
    const context = new ContextManager({
        ...(deps.systemPrompt !== undefined ? { systemPrompt: deps.systemPrompt } : {}),
        tools: deps.tools ?? [],
        ...(deps.history !== undefined ? { history: deps.history } : {}),
        ...(deps.redactor !== undefined ? { redactor: deps.redactor } : {}),
    });
    context.appendUser(goal.statement);
    const steps: Step[] = [];

    // Persist the task before the first round. Live observers rebuild the tree via
    // GoalStore.listTasks(); without an early row the task (and all its in-progress
    // steps) stays invisible to /timeline until the task finishes.
    task.status = 'active';
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
        });
    };

    // 死循环护栏：连续相同工具调用达 3 轮视为未收敛（不烧完剩余轮次）
    let prevCallKey: string | undefined;
    let repeatCount = 0;

    try {
        for (let roundIndex = 0; roundIndex < maxSteps; roundIndex += 1) {
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
                    task.status = 'failed';
                    await saveTask();
                    return {
                        task,
                        steps,
                        ok: false,
                        reason: 'max-steps',
                        errorMessage: `工具调用未收敛：连续 3 轮相同调用 ${round.toolCalls[0]?.toolName}`,
                    };
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

            // 执行工具（结果合并回 invocation step；模型提议见 deliberation.toolCalls）
            const outputs: Array<{ callId: string; output: string; isError: boolean }> = [];
            for (const call of round.toolCalls) {
                const toolStep: Extract<Step, { kind: 'invocation' }> = {
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
                    status: 'active',
                    startedAt: now(),
                    endedAt: now(),
                };
                // usage 归模型生成，已在 deliberation 步骤；invocation 不承载 usage。
                steps.push(toolStep);
                await deps.store.saveStep(toolStep);
                deps.onStep?.(toolStep);

                const res = await invoker.invoke(call.toolName, call.arguments, {
                    stepId: toolStep.stepId,
                    taskId: task.taskId,
                });
                const output = res.ok ? res.content : (res.error ?? 'tool failed');
                outputs.push({
                    callId: call.callId,
                    output,
                    isError: !res.ok,
                });
                // 执行结果合并回 invocation step；失败以 StepError（四源标签 tool）表达，
                // 不在 payload 上再设 isError/structured。
                toolStep.payload.output = output;
                toolStep.status = res.ok ? 'succeeded' : 'error';
                if (!res.ok) {
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
