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
        // 节点轨迹是真实 workflow 节点，不是“一步一思考”
        expect(result.loop?.nodeTrail?.some((node) => node.role === 'think')).toBe(true);
        expect(result.loop?.nodeTrail?.some((node) => node.role === 'act')).toBe(true);
        expect(result.loop?.nodeTrail?.filter((node) => node.kind === 'selected')).toHaveLength(
            result.loop?.nodes ?? 0,
        );
        const selected = result.loop?.nodeTrail?.filter((node) => node.kind === 'selected') ?? [];
        expect(selected[0]?.reason).toBe('start→think');
        expect(selected.some((node) => /^(\w+)→\1$/.test(node.reason ?? ''))).toBe(false);
        expect(result.loop?.nodeTrail?.at(-1)?.kind).toBe('terminated');
        for (const item of result.tasks) {
            expect((await store.loadTask(item.task.taskId))?.status).toBe('succeeded');
        }
        const steps = await store.listSteps(result.tasks[0]!.task.taskId);
        expect(steps.length).toBeGreaterThan(0);
        expect(steps.every((step) => step.role === 'think')).toBe(true);
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

    it('onWorkflowNode 逐节点回调（供实时 trace 使用）', async () => {
        const store = new MemoryGoalStore();
        const a = goal(ulid());
        await store.saveGoal(a);
        const roles: string[] = [];
        await runGoalTreeDynamic(
            {
                store,
                requestRound: async () => okRound,
                onWorkflowNode: (event) => {
                    if (event.role !== undefined) roles.push(event.role);
                },
            },
            [a],
        );
        expect(roles).toContain('think');
        expect(roles).toContain('act');
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
