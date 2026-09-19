import { describe, expect, it } from 'vitest';
import type { Goal, Task } from '../../core/src/gts.js';
import { ulid } from '../../core/src/ulid.js';
import { executeTask } from '../src/gts/goal-executor.js';
import type { RoundResult } from '../src/gts/round-types.js';
import { MemoryGoalStore } from '../src/memory/goal-store.js';
import { runGoalTree } from '../src/strategy/goal-strategy.js';

function goal(status: Goal['status'] = 'active'): Goal {
    return {
        goalId: ulid(),
        origin: { kind: 'human' },
        statement: '执行一个需要多轮工具的任务',
        contract: {
            successConditions: [{ id: ulid(), checkType: 'deterministic' }],
            failureConditions: [],
            forbiddenResources: [],
            budget: {},
            terminationPolicy: {},
            riskProfile: {
                hasIrreversibleActions: false,
                touchesNetwork: false,
                touchesExternalApi: false,
            },
        },
        permissionCeiling: 'read-only',
        budget: {},
        status,
        createdAt: 1,
    };
}

function task(goalId: string, status: Task['status'] = 'pending'): Task {
    return {
        taskId: ulid(),
        goalId,
        title: '执行任务',
        acceptance: { conditions: ['c1'] },
        status,
    };
}

const okRound: RoundResult = {
    text: '最终回答',
    reasoning: '',
    toolCalls: [],
    finishReason: 'stop',
    ttftMs: 0,
    totalMs: 1,
};

const toolRound: RoundResult = {
    text: '',
    reasoning: '',
    toolCalls: [{ callId: 'c1', toolName: 'noop', arguments: { x: 1 } }],
    finishReason: 'tool_calls',
    ttftMs: 0,
    totalMs: 1,
};

describe('goal-executor 中断/恢复（IR-B）', () => {
    it('工具轮后中断：Task 置 aborted，已落库 Step 保持完整', async () => {
        const store = new MemoryGoalStore();
        const g = goal();
        const t = task(g.goalId);
        const controller = new AbortController();
        let invoked = 0;
        const outcome = await executeTask(
            {
                store,
                signal: controller.signal,
                allowedTools: ['noop'],
                invoker: {
                    invoke: async () => {
                        invoked += 1;
                        controller.abort();
                        return { ok: true, content: 'OUT' };
                    },
                },
                requestRound: async () => toolRound,
            },
            t,
            g,
        );
        expect(outcome.ok).toBe(false);
        expect(outcome.reason).toBe('aborted');
        expect(invoked).toBe(1);
        const steps = await store.listSteps(t.taskId);
        expect(steps.map((step) => step.kind)).toEqual(['deliberation', 'invocation']);
        expect((await store.loadTask(t.taskId))?.status).toBe('aborted');
    });

    it('模型轮被中断：被中断轮不落 Step，checkpoint 停留在上一轮', async () => {
        const store = new MemoryGoalStore();
        const g = goal();
        const t = task(g.goalId);
        const controller = new AbortController();
        const outcome = await executeTask(
            {
                store,
                signal: controller.signal,
                requestRound: async () => {
                    controller.abort();
                    throw new Error('aborted by caller');
                },
            },
            t,
            g,
        );
        expect(outcome.reason).toBe('aborted');
        expect(await store.listSteps(t.taskId)).toEqual([]);
        expect((await store.loadTask(t.taskId))?.status).toBe('aborted');
    });

    it('恢复：重放已落库 Step，不重复成功工具调用，续跑至成功', async () => {
        const store = new MemoryGoalStore();
        const g = goal();
        const t = task(g.goalId);
        const controller = new AbortController();
        let invoked = 0;
        const first = await executeTask(
            {
                store,
                signal: controller.signal,
                allowedTools: ['noop'],
                invoker: {
                    invoke: async () => {
                        invoked += 1;
                        controller.abort();
                        return { ok: true, content: 'OUT' };
                    },
                },
                requestRound: async () => toolRound,
            },
            t,
            g,
        );
        expect(first.reason).toBe('aborted');
        const abortedTask = (await store.loadTask(t.taskId))!;
        expect(abortedTask.status).toBe('aborted');
        const persisted = await store.listSteps(t.taskId);
        let sawReplayedToolResult = false;
        const resumed = await executeTask(
            {
                store,
                allowedTools: ['noop'],
                invoker: {
                    invoke: async () => {
                        invoked += 1;
                        return { ok: true, content: 'AGAIN' };
                    },
                },
                resumeSteps: persisted,
                requestRound: async (ctx) => {
                    sawReplayedToolResult = ctx.messages.some((message) => message.role === 'tool');
                    return okRound;
                },
            },
            abortedTask,
            g,
        );
        expect(resumed.ok).toBe(true);
        expect(resumed.reason).toBe('final-answer');
        expect(sawReplayedToolResult).toBe(true);
        expect(invoked).toBe(1);
        const all = await store.listSteps(t.taskId);
        // 工具调用步只有原有一个（未新增/未重复）；历史 Step 之上追加了新 deliberation。
        const invocationIds = all
            .filter((step) => step.kind === 'invocation')
            .map((step) => step.stepId);
        const persistedInvocation = persisted.find((step) => step.kind === 'invocation');
        expect(invocationIds).toEqual([persistedInvocation?.stepId]);
        expect(all.filter((step) => step.kind === 'deliberation')).toHaveLength(2);
        expect((await store.loadTask(t.taskId))?.status).toBe('succeeded');
    });
});

describe('goal-strategy 恢复（IR-C）', () => {
    it('resume：复用已中断 Task，不新建 Task，并在历史之后追加 Step', async () => {
        const store = new MemoryGoalStore();
        const g = goal('aborted');
        await store.saveGoal(g);
        const t = task(g.goalId, 'aborted');
        await store.saveTask(t);
        await store.saveStep({
            stepId: ulid(),
            taskId: t.taskId,
            goalId: g.goalId,
            kind: 'deliberation',
            payload: { answer: 'partial' },
            status: 'succeeded',
            startedAt: 1,
            endedAt: 2,
        });
        const result = await runGoalTree(
            { store, resume: true, requestRound: async () => okRound },
            [g],
        );
        expect(result.ok).toBe(true);
        const tasks = await store.listTasks(g.goalId);
        expect(tasks).toHaveLength(1);
        expect(tasks[0]?.taskId).toBe(t.taskId);
        expect(await store.listSteps(t.taskId)).toHaveLength(2);
        expect((await store.loadTask(t.taskId))?.status).toBe('succeeded');
    });

    it('非恢复模式忽略 aborted Goal，不产生 Task', async () => {
        const store = new MemoryGoalStore();
        const g = goal('aborted');
        await store.saveGoal(g);
        const result = await runGoalTree({ store, requestRound: async () => okRound }, [g]);
        expect(result.tasks).toEqual([]);
        expect(await store.listTasks(g.goalId)).toEqual([]);
    });
});
