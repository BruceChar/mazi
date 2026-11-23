import { describe, expect, it } from 'vitest';
import type { Goal, ULID } from '@mazi/core';
import { ulid } from '@mazi/core';
import type { RoundResult } from '../src/gts/round-types.js';
import { MemoryGoalStore } from '../src/memory/goal-store.js';
import { runGoalTreeDynamic } from '../src/strategy/dynamic-loop.js';

function goal(id: ULID): Goal {
    return {
        goalId: id,
        origin: { kind: 'human' },
        statement: `任务-${id}`,
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
        status: 'active',
        createdAt: 1,
    };
}

const okRound: RoundResult = {
    text: '已完成。',
    reasoning: '',
    toolCalls: [],
    finishReason: 'stop',
    ttftMs: 0,
    totalMs: 1,
};

describe('dynamic loop（节点驱动）', () => {
    it('两个 Goal：节点依次执行两 Task，ok 且落库', async () => {
        const store = new MemoryGoalStore();
        const a = goal(ulid());
        const b = goal(ulid());
        await store.saveGoal(a);
        await store.saveGoal(b);
        const result = await runGoalTreeDynamic({ store, requestRound: async () => okRound }, [a, b]);
        expect(result.ok).toBe(true);
        expect(result.tasks.map((item) => item.task.goalId)).toEqual([a.goalId, b.goalId]);
        expect(result.loop?.mode).toBe('dynamic');
        expect(result.loop?.nodes).toBeGreaterThan(0);
        for (const item of result.tasks) {
            expect((await store.loadTask(item.task.taskId))?.status).toBe('succeeded');
        }
    });

    it('计划被存储，且 onPlan 只触发一次', async () => {
        const store = new MemoryGoalStore();
        const a = goal(ulid());
        await store.saveGoal(a);
        const plans: number[] = [];
        await runGoalTreeDynamic(
            { store, requestRound: async () => okRound, onPlan: (count) => plans.push(count) },
            [a],
        );
        expect(plans).toEqual([1]);
        expect(await store.listTasks(a.goalId)).toHaveLength(1);
    });

    it('独立验收失败时 Task 记 failed、整体 ok=false', async () => {
        const store = new MemoryGoalStore();
        const a = goal(ulid());
        await store.saveGoal(a);
        const result = await runGoalTreeDynamic(
            {
                store,
                requestRound: async () => okRound,
                verifier: {
                    verify: async (_goal, outcome) => ({
                        verifierId: 'test',
                        state: 'failed',
                        acceptance: { passed: false, conditions: [] },
                        evidence: [],
                    }),
                } as never,
            },
            [a],
        );
        expect(result.ok).toBe(false);
        expect(result.tasks[0]?.task.status).toBe('failed');
    });

    it('resume 明确拒绝（v1 不支持）', async () => {
        const store = new MemoryGoalStore();
        const a = goal(ulid());
        await store.saveGoal(a);
        await expect(
            runGoalTreeDynamic({ store, requestRound: async () => okRound, resume: true }, [a]),
        ).rejects.toThrow(/resume/);
    });
});
