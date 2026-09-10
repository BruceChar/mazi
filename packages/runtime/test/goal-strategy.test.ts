import { describe, expect, it } from 'vitest';
import type { Goal, ULID } from '@mazi/core';
import { ulid } from '@mazi/core';
import type { RoundResult } from '../src/gts/round-types.js';
import { MemoryGoalStore } from '../src/memory/goal-store.js';
import { runGoalTree } from '../src/strategy/goal-strategy.js';


function goal(id: ULID, kind: 'intake' | 'work', root: ULID = ulid()): Goal {
    return {
        goalId: id,
        rootGoalId: root,
        origin: kind === 'intake' ? { kind: 'human' } : undefined,
        parent: kind === 'work' ? { type: 'split', goalId: root } : undefined,
        kind,
        statement: kind === 'work' ? `任务-${id}` : '切分入口',
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

describe('goal-strategy（C3d：Goal 树顺序驱动）', () => {
    it('intake + 两个 work 兄弟：依次执行两 Task，全部 ok', async () => {
        const store = new MemoryGoalStore();
        const root = goal(ulid(), 'intake');
        const a = goal(ulid(), 'work', root.goalId);
        const b = goal(ulid(), 'work', root.goalId);
        await store.saveGoal(root);
        await store.saveGoal(a);
        await store.saveGoal(b);
        const result = await runGoalTree({ store, requestRound: async () => okRound }, [
            root,
            a,
            b,
        ]);
        expect(result.ok).toBe(true);
        expect(result.tasks.map((x) => x.task.goalId)).toEqual([a.goalId, b.goalId]);
        const taskIds = result.tasks.map((x) => x.task.taskId);
        expect((await store.listSteps(taskIds[0]!))[0]?.goalId).toBe(a.goalId);
        expect((await store.listSteps(taskIds[1]!))[0]?.goalId).toBe(b.goalId);
        expect((await store.loadTask(taskIds[0]!))?.status).toBe('succeeded');
    });

    it('孤儿 Goal 树：拒绝出计划，返回 rejected', async () => {
        const orphan: Goal = goal(ulid(), 'work');
        orphan.parent = { type: 'split', goalId: ulid() };
        const result = await runGoalTree(
            { store: new MemoryGoalStore(), requestRound: async () => okRound },
            [orphan],
        );
        expect(result.ok).toBe(false);
        expect(result.rejected?.[0]).toContain('parent');
        expect(result.tasks).toEqual([]);
    });
});
