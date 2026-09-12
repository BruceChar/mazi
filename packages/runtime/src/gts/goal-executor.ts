/**
 * goal-executor —— Task 执行（C3c 起步，C5-1 补全工具闭环）。
 * 复用 requestRound 执行面：模型轮 → 有 toolCalls →（白名单 → 工具调用 → 观察）→ 追加消息继续，
 * 无 toolCalls → 最终回答。Step 归因 taskId/goalId，全部经 GoalStore 持久化。
 */

import type { Goal, LLMMessage, Step, Task, ToolSchema } from '@mazi/core';
import { ulid } from '@mazi/core';
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
        data?: unknown;
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
    /** 工作目录（工具实际执行目录；入库到 tool_call payload.cwd 供展示/追溯） */
    workspaceRoot?: string;
    maxSteps?: number;
    now?: () => number;
    /** Step 落库后即时回调（流式上报：思考/工具/观察），供事件总线实时推送给 UI */
    onStep?: (step: Step) => void;
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

function toUserMessage(statement: string): LLMMessage {
    return { role: 'user', content: [{ type: 'text', text: statement }] };
}

export async function executeTask(
    deps: GoalExecutorDeps,
    task: Task,
    goal: Goal,
): Promise<TaskOutcome> {
    const now = deps.now ?? Date.now;
    // 真实模型对项目类任务往往需要多轮工具调用后才收敛，默认上限放宽到 50
    const maxSteps = deps.maxSteps ?? 50;
    const invoker = deps.invoker;
    const allowed = new Set(deps.allowedTools ?? []);
    const history = deps.history ?? [];
    const messages: LLMMessage[] = [...history, toUserMessage(goal.statement)];
    const steps: Step[] = [];

    // Persist the task before the first round. Live observers rebuild the tree via
    // GoalStore.listTasks(); without an early row the task (and all its in-progress
    // steps) stays invisible to /timeline until the task finishes.
    task.status = 'running';
    await deps.store.saveTask(task);

    const roundRequest = (): Promise<RoundResult> =>
        deps.requestRound({
            goalId: task.goalId,
            taskId: task.taskId,
            model: deps.model ?? { providerId: 'default', modelId: 'default' },
            messages,
            baseMessageCount: history.length,
            ...(deps.systemPrompt ? { systemPrompt: deps.systemPrompt } : {}),
            tools: deps.tools ?? [],
        });

    // 死循环护栏：连续相同工具调用达 3 轮视为未收敛（不烧完剩余轮次）
    let prevCallKey: string | undefined;
    let repeatCount = 0;

    try {
        for (let roundIndex = 0; roundIndex < maxSteps; roundIndex += 1) {
            const round = await roundRequest();

            // 一轮 usage 归属：thinking 与 intent（模型输出）都挂同一份（带 roundId）；
            // 审计聚合按 roundId 去重，保证「首步 thinking 有统计」且总量只计一次；
            // 两者都不存在时退到本轮的 tool_call step。
            const generationMs = round.totalMs - round.ttftMs;
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
            const hasTextOrThinking = round.text.length > 0 || round.reasoning.length > 0;
            const attachUsage = (step: Step) => {
                if (step.usage !== undefined || roundUsageWithId === undefined) return;
                // 模型输出/推理所属 step 全部携带同一份 usage；纯工具轮次只挂 tool_call。
                if (hasTextOrThinking) {
                    if (step.kind === 'thinking' || step.kind === 'intent') {
                        step.usage = roundUsageWithId;
                    }
                    return;
                }
                if (step.kind === 'tool_call') {
                    step.usage = roundUsageWithId;
                }
            };

            // thinking step: reasoning process only (not model output)
            if (round.reasoning.length > 0) {
                const thinking: Step = {
                    stepId: ulid(),
                    taskId: task.taskId,
                    goalId: task.goalId,
                    kind: 'thinking',
                    payload: {
                        content: round.reasoning,
                        ...(round.reasoning.length > 200
                            ? { contextContent: round.reasoning.slice(0, 200) }
                            : {}),
                    },
                    status: 'ok',
                    startedAt: now(),
                    endedAt: now(),
                };
                attachUsage(thinking);
                steps.push(thinking);
                await deps.store.saveStep(thinking);
                deps.onStep?.(thinking);
            }

            // intent step: model output / final answer (distinct from reasoning)
            if (round.text.length > 0) {
                const intent: Step = {
                    stepId: ulid(),
                    taskId: task.taskId,
                    goalId: task.goalId,
                    kind: 'intent',
                    payload: {
                        content: round.text,
                        ...(round.text.length > 200
                            ? { contextContent: round.text.slice(0, 200) }
                            : {}),
                    },
                    status: 'ok',
                    startedAt: now(),
                    endedAt: now(),
                };
                attachUsage(intent);
                steps.push(intent);
                await deps.store.saveStep(intent);
                deps.onStep?.(intent);
            }

            if (round.toolCalls.length === 0) {
                task.status = 'succeeded';
                await deps.store.saveTask(task);
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
                await deps.store.saveTask(task);
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
                    await deps.store.saveTask(task);
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
                    kind: 'tool_call',
                    payload: {
                        toolName: blocked.toolName,
                        arguments: blocked.arguments,
                        ...(deps.workspaceRoot !== undefined ? { cwd: deps.workspaceRoot } : {}),
                    },
                    status: 'blocked',
                    startedAt: now(),
                    endedAt: now(),
                };
                attachUsage(callStep);
                steps.push(callStep);
                await deps.store.saveStep(callStep);
                deps.onStep?.(callStep);
                task.status = 'failed';
                await deps.store.saveTask(task);
                return {
                    task,
                    steps,
                    ok: false,
                    reason: 'blocked-tool',
                    errorMessage: `工具被策略拦截：${blocked.toolName}`,
                };
            }

            // 执行工具（输出合并到 tool_call step，不再单独生成 observation step）
            const outputs: Array<{ callId: string; output: string; isError: boolean }> = [];
            for (const call of round.toolCalls) {
                const toolStep: Step = {
                    stepId: ulid(),
                    taskId: task.taskId,
                    goalId: task.goalId,
                    kind: 'tool_call',
                    payload: {
                        toolName: call.toolName,
                        arguments: call.arguments,
                        callId: call.callId,
                        ...(deps.workspaceRoot !== undefined ? { cwd: deps.workspaceRoot } : {}),
                    },
                    status: 'running',
                    startedAt: now(),
                    endedAt: now(),
                };
                attachUsage(toolStep);
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
                // Merge output into the tool_call step
                toolStep.payload = {
                    ...toolStep.payload,
                    output,
                    ...(res.ok ? {} : { isError: true }),
                    ...(res.data !== undefined ? { structured: { data: res.data } } : {}),
                } as Step['payload'];
                toolStep.status = res.ok ? 'ok' : 'error';
                toolStep.endedAt = now();
                await deps.store.saveStep(toolStep);
                deps.onStep?.(toolStep);
            }
            // 回注：assistant toolCalls + tool 结果消息；模型本轮文本一并回注（截断防爆上下文），
            // 避免模型在后续轮次“失忆”而重复发起相同工具调用
            messages.push({
                role: 'assistant',
                content:
                    round.text.length > 0
                        ? [{ type: 'text', text: round.text.slice(0, 4000) }]
                        : [],
                toolCalls: round.toolCalls.map((c) => ({
                    callId: c.callId,
                    name: c.toolName,
                    arguments: c.arguments,
                })),
            });
            messages.push({ role: 'tool', results: outputs });
        }
        task.status = 'failed';
        await deps.store.saveTask(task);
        return { task, steps, ok: false, reason: 'max-steps', errorMessage: '达到 Task 最大轮次' };
    } catch (error) {
        task.status = 'failed';
        await deps.store.saveTask(task);
        return {
            task,
            steps,
            ok: false,
            reason: 'driver-error',
            ...(error instanceof Error ? { errorMessage: error.message } : {}),
        };
    }
}
