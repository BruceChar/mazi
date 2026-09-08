/**
 * goal-executor —— Task 执行（C3c 起步，C5-1 补全工具闭环）。
 * 复用 requestRound 执行面：模型轮 → 有 toolCalls →（白名单 → 工具调用 → 观察）→ 追加消息继续，
 * 无 toolCalls → 最终回答。Step 归因 taskId/goalId，全部经 GoalStore 持久化。
 */

import type { LLMMessage, ToolSchema } from '@mazi/core';
import type { Goal, Step, Task } from '../../../core/src/goal-coordinate.js';
import type { GoalStore } from '../memory/goal-store.js';
import type { ExecutorRoundContext, RoundResult } from './round-types.js';

export interface GoalToolInvoker {
    invoke(
        toolName: string,
        args: Record<string, unknown>,
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
    maxSteps?: number;
    now?: () => number;
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
    const maxSteps = deps.maxSteps ?? 20;
    const invoker = deps.invoker;
    const allowed = new Set(deps.allowedTools ?? []);
    const messages: LLMMessage[] = [toUserMessage(goal.statement)];
    const steps: Step[] = [];

    const roundRequest = (): Promise<RoundResult> =>
        deps.requestRound({
            model: deps.model ?? { providerId: 'default', modelId: 'default' },
            messages,
            ...(deps.systemPrompt ? { systemPrompt: deps.systemPrompt } : {}),
            tools: deps.tools ?? [],
        });

    try {
        for (let roundIndex = 0; roundIndex < maxSteps; roundIndex += 1) {
            const round = await roundRequest();
            const text = round.text.length > 0 ? round.text : round.reasoning;
            const thinking: Step = {
                stepId: `step-${task.taskId}-${now()}-${roundIndex}`,
                taskId: task.taskId,
                goalId: task.goalId,
                kind: 'thinking',
                payload: {
                    content: text,
                    ...(text.length > 200 ? { contextContent: text.slice(0, 200) } : {}),
                },
                status: 'ok',
                startedAt: now(),
                endedAt: now(),
            };
            steps.push(thinking);
            await deps.store.saveStep(thinking);

            if (round.toolCalls.length === 0) {
                task.status = 'succeeded';
                await deps.store.saveTask(task);
                return {
                    task,
                    steps,
                    ok: true,
                    reason: 'final-answer',
                    ...(text.length > 0 ? { finalMessage: text } : {}),
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

            // 白名单检查：违规工具整轮拒绝（先拦后停，policy 语义）
            const blocked = round.toolCalls.find(
                (c) => allowed.size > 0 && !allowed.has(c.toolName),
            );
            if (blocked !== undefined) {
                const callStep: Step = {
                    stepId: `step-${task.taskId}-${now()}-blocked`,
                    taskId: task.taskId,
                    goalId: task.goalId,
                    kind: 'tool_call',
                    payload: { toolName: blocked.toolName, arguments: blocked.arguments },
                    status: 'blocked',
                    startedAt: now(),
                    endedAt: now(),
                };
                steps.push(callStep);
                await deps.store.saveStep(callStep);
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

            // 执行工具 + 观察 Step
            const outputs: Array<{ callId: string; output: string; isError: boolean }> = [];
            for (const call of round.toolCalls) {
                const toolStep: Step = {
                    stepId: `step-${task.taskId}-${now()}-tool-${call.callId}`,
                    taskId: task.taskId,
                    goalId: task.goalId,
                    kind: 'tool_call',
                    payload: {
                        toolName: call.toolName,
                        arguments: call.arguments,
                        callId: call.callId,
                    },
                    status: 'ok',
                    startedAt: now(),
                    endedAt: now(),
                };
                steps.push(toolStep);
                await deps.store.saveStep(toolStep);

                const res = await invoker.invoke(call.toolName, call.arguments);
                outputs.push({
                    callId: call.callId,
                    output: res.ok ? res.content : (res.error ?? 'tool failed'),
                    isError: !res.ok,
                });
                const obs: Step = {
                    stepId: `step-${task.taskId}-${now()}-obs-${call.callId}`,
                    taskId: task.taskId,
                    goalId: task.goalId,
                    kind: 'observation',
                    payload: {
                        toolName: call.toolName,
                        content: res.ok ? res.content : (res.error ?? 'tool failed'),
                        ...(res.ok ? {} : { isError: true }),
                        ...(res.data !== undefined ? { structured: { data: res.data } } : {}),
                    },
                    status: 'ok',
                    startedAt: now(),
                    endedAt: now(),
                };
                steps.push(obs);
                await deps.store.saveStep(obs);
            }
            // 回注：assistant toolCalls + tool 结果消息
            messages.push({
                role: 'assistant',
                content: [],
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
