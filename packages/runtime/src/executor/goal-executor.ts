/**
 * goal-executor —— Task 执行（C3c，单轮 MVP）。
 * 复用 runtime 的 requestRound 执行面（provider-runtime RoundExecutor / 测试 fake），
 * 产出坐标 Step（归因 taskId/goalId）并经 GoalStore 持久化。
 * 本轮范围：thinking Step + final-answer；工具循环与 Policy 后续（C3d-e 复用旧 Executor 加工面）。
 */

import type { LLMMessage, ToolSchema } from '@mazi/core';
import type { Goal, Step, Task } from '../../../core/src/goal-coordinate.js';
import type { ExecutorRoundContext, RoundResult } from '../executor/executor.js';
import type { GoalStore } from '../memory/goal-store.js';

export interface GoalExecutorDeps {
    store: GoalStore;
    /** 单次 LLM 轮次（注入：provider-runtime RoundExecutor / 测试 fake） */
    requestRound: (ctx: ExecutorRoundContext) => Promise<RoundResult>;
    /** 首选模型（缺省占位；经 runtime 装配时由容量决定） */
    model?: { providerId: string; modelId: string };
    systemPrompt?: string;
    tools?: ToolSchema[];
    now?: () => number;
}

export interface TaskOutcome {
    task: Task;
    steps: Step[];
    ok: boolean;
    reason: 'final-answer' | 'driver-error';
    finalMessage?: string;
    errorMessage?: string;
}

/** 把 Task 的 Goal 陈述作为 user 输入构建一条 Block 消息（复用新 provider 消息模型） */
function toUserMessage(statement: string): LLMMessage {
    return { role: 'user', content: [{ type: 'text', text: statement }] };
}

export async function executeTask(
    deps: GoalExecutorDeps,
    task: Task,
    goal: Goal,
): Promise<TaskOutcome> {
    const now = deps.now ?? Date.now;
    const messages: LLMMessage[] = [toUserMessage(goal.statement)];
    let round: RoundResult;
    try {
        round = await deps.requestRound({
            model: deps.model ?? { providerId: 'default', modelId: 'default' },
            messages,
            ...(deps.systemPrompt ? { systemPrompt: deps.systemPrompt } : {}),
            tools: deps.tools ?? [],
        });
    } catch (error) {
        return {
            task,
            steps: [],
            ok: false,
            reason: 'driver-error',
            ...(error instanceof Error ? { errorMessage: error.message } : {}),
        };
    }

    const text = round.text.length > 0 ? round.text : round.reasoning;
    const thinkingStep: Step = {
        stepId: `step-${task.taskId}-${now()}`,
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
    await deps.store.saveStep(thinkingStep);

    task.status = 'succeeded';
    await deps.store.saveTask(task);
    return {
        task,
        steps: [thinkingStep],
        ok: true,
        reason: 'final-answer',
        ...(text.length > 0 ? { finalMessage: text } : {}),
    };
}
