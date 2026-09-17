import { describe, expect, it } from 'vitest';
import type { Goal, ULID } from '@mazi/core';
import { ulid } from '@mazi/core';
import type { RoundResult } from '../src/gts/round-types.js';
import { MemoryGoalStore } from '../src/memory/goal-store.js';
import { runGoalTree } from '../src/strategy/goal-strategy.js';


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

describe('goal-strategy（C3d：Goal 顺序驱动，扁平模型）', () => {
    it('多个独立 Goal：依次执行两 Task，全部 ok', async () => {
        const store = new MemoryGoalStore();
        const a = goal(ulid());
        const b = goal(ulid());
        await store.saveGoal(a);
        await store.saveGoal(b);
        const result = await runGoalTree({ store, requestRound: async () => okRound }, [a, b]);
        expect(result.ok).toBe(true);
        expect(result.rootGoalId).toBe(a.goalId);
        expect(result.tasks.map((x) => x.task.goalId)).toEqual([a.goalId, b.goalId]);
        const taskIds = result.tasks.map((x) => x.task.taskId);
        expect((await store.listSteps(taskIds[0]!))[0]?.goalId).toBe(a.goalId);
        expect((await store.listSteps(taskIds[1]!))[0]?.goalId).toBe(b.goalId);
        expect((await store.loadTask(taskIds[0]!))?.status).toBe('succeeded');
    });

    it('多 Task 共享上下文：第二个 Task 前置第一个 Task 的输入与回答', async () => {
        const store = new MemoryGoalStore();
        const a = goal(ulid());
        const b = goal(ulid());
        await store.saveGoal(a);
        await store.saveGoal(b);
        const seen: string[][] = [];
        const bases: Array<number | undefined> = [];
        await runGoalTree(
            {
                store,
                requestRound: async (ctx) => {
                    seen.push(
                        ctx.messages.map((message) =>
                            message.role === 'user' || message.role === 'assistant'
                                ? message.content
                                      .map((block) => (block.type === 'text' ? block.text : ''))
                                      .join('')
                                : '',
                        ),
                    );
                    bases.push(ctx.baseMessageCount);
                    return okRound;
                },
            },
            [a, b],
        );
        expect(seen[0]).toEqual([a.statement]);
        expect(bases[0]).toBe(0);
        expect(seen[1]).toEqual([a.statement, '已完成。', b.statement]);
        expect(bases[1]).toBe(2);
    });

    it('无 active Goal：不产生任务（空运行），rootGoalId 取 goals[0]', async () => {
        const pending = goal(ulid());
        pending.status = 'pending';
        const result = await runGoalTree(
            { store: new MemoryGoalStore(), requestRound: async () => okRound },
            [pending],
        );
        expect(result.rootGoalId).toBe(pending.goalId);
        expect(result.tasks).toEqual([]);
        expect(result.ok).toBe(true);
    });
});
