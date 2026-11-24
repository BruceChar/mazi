/**
 * goal-executor —— Task 执行的兼容入口。
 * 单轮效果在 task-execution.ts；调度与终止统一交给 WorkflowRunner。
 */
import type { Goal, Task } from '@mazi/core';
import { createBuiltinNodes } from '../workflow/nodes.js';
import { WorkflowRunner } from '../workflow/runner.js';
import { DEFAULT_LIMITS, type WorkflowState } from '../workflow/types.js';
import {
    type ActOutput,
    type GoalExecutorDeps,
    TaskExecutionContext,
    type TaskOutcome,
    type TaskStopReason,
} from './task-execution.js';

export type {
    GoalExecutorDeps,
    GoalToolInvoker,
    TaskOutcome,
    TaskStopReason,
} from './task-execution.js';
export { TaskExecutionContext };

function actDelta(outputs: ActOutput[]): WorkflowState['pending'] {
    return outputs.map((item) => ({
        callId: item.callId,
        ok: !item.isError,
        text: item.output.slice(0, 2000),
    }));
}

function taskState(task: Task, goal: Goal): WorkflowState {
    return {
        goalId: goal.goalId,
        statement: goal.statement,
        phase: 'think',
        plan: { version: 1, tasks: [{ id: task.taskId, title: task.title, status: 'open' }] },
        facts: [],
        pending: [],
        acceptance: [],
        verdict: 'pending',
        failures: 0,
        actedSincePlan: 0,
        usage: { steps: 0, elapsedMs: 0, tokens: 0, costUsd: 0 },
        startedAt: Date.now(),
    };
}

export async function executeTask(
    deps: GoalExecutorDeps,
    task: Task,
    goal: Goal,
): Promise<TaskOutcome> {
    const ctx = new TaskExecutionContext(deps, task, goal);
    await ctx.start();
    if (ctx.isTerminal) return ctx.outcome();

    const nodes = createBuiltinNodes(
        {
            think: async () => {
                const result = await ctx.reason();
                if (result === 'failed') return { terminal: 'failed' as const };
                if (result === 'final') {
                    await ctx.finishSuccess();
                    return { terminal: 'done' as const };
                }
                return { next: 'act' as const };
            },
            act: async () => {
                const result = await ctx.act();
                if (result === 'failed') return { terminal: 'failed' as const };
                return {
                    delta: { pending: actDelta([...ctx.lastOutputs]) },
                    next: 'observe' as const,
                };
            },
            observe: async () => {
                const result = await ctx.observe();
                if (result === 'failed') return { terminal: 'failed' as const };
                if (result === 'final') {
                    await ctx.finishSuccess();
                    return { terminal: 'done' as const };
                }
                return { next: 'think' as const };
            },
        },
        { ...DEFAULT_LIMITS, maxSteps: Math.max(12, ctx.maxRoundCount * 4 + 4) },
    );

    const runner = new WorkflowRunner(
        nodes,
        {
            base: '',
            byRole: {
                think: '',
                act: '',
                observe: '',
                plan: '',
                verify: '',
                reflect: '',
            },
        },
        {
            ...DEFAULT_LIMITS,
            maxSteps: Math.max(12, ctx.maxRoundCount * 4 + 4),
            maxNoProgress: 8,
            maxElapsedMs: Number.MAX_SAFE_INTEGER,
        },
    );
    const run = await runner.run(taskState(task, goal));
    if (!ctx.isTerminal) {
        if (ctx.isAwaitingVerify) await ctx.finishSuccess();
        else {
            const reason: TaskStopReason = run.outcome === 'failed' ? 'driver-error' : 'max-steps';
            await ctx.applyAcceptance('failed');
            // 保留 runner 的终止原因供调用方审计；Task 状态已落库。
            return {
                task: ctx.task,
                steps: ctx.outcome().steps,
                ok: false,
                reason,
                errorMessage: `workflow 提前终止：${run.outcome}`,
            };
        }
    }
    return ctx.outcome();
}
