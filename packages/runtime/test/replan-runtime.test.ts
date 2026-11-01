import type { Goal } from '@mazi/core';
import { ulid } from '@mazi/core';
import { describe, expect, it } from 'vitest';
import type { RoundResult } from '../src/gts/round-types.js';
import { MemoryGoalStore } from '../src/memory/goal-store.js';
import { runGoalTree } from '../src/strategy/goal-strategy.js';
import { IndependentVerifier } from '../src/verifier/index.js';

function goal(): Goal {
    const condition = ulid();
    return {
        goalId: ulid(),
        statement: '完成长程任务',
        contract: {
            successConditions: [
                {
                    id: condition,
                    checkType: 'deterministic',
                    check: { kind: 'final-answer' },
                },
            ],
            failureConditions: [],
            forbiddenResources: [],
            budget: { maxCostUsd: 10 },
            terminationPolicy: { maxSteps: 5 },
            riskProfile: {
                hasIrreversibleActions: false,
                touchesNetwork: false,
                touchesExternalApi: false,
            },
        },
        permissionCeiling: 'workspace-write',
        budget: { maxCostUsd: 10 },
        status: 'active',
        createdAt: 1,
    };
}

const okRound: RoundResult = {
    text: '恢复后完成',
    reasoning: '',
    toolCalls: [],
    finishReason: 'stop',
    ttftMs: 0,
    totalMs: 1,
};

describe('dynamic replan runtime', () => {
    it('uses verifier failure evidence to replace a failed task and continue', async () => {
        const store = new MemoryGoalStore();
        const target = goal();
        await store.saveGoal(target);
        let requests = 0;
        const replanReasons: Array<string | undefined> = [];
        const result = await runGoalTree(
            {
                store,
                verifier: new IndependentVerifier(),
                requestRound: async () => {
                    requests += 1;
                    if (requests === 1) throw new Error('model unavailable');
                    return okRound;
                },
                replan: {
                    maxReplans: 1,
                    planner: async (request) => {
                        replanReasons.push(request.failureCategory);
                        return [
                            {
                                key: 'recovery',
                                title: '使用备用方案',
                                acceptanceConditionIds: [
                                    target.contract.successConditions[0]!.id,
                                ],
                                budget: { maxCostUsd: 2 },
                            },
                        ];
                    },
                },
            },
            [target],
        );
        expect(result.ok).toBe(true);
        expect(result.tasks).toHaveLength(1);
        expect(result.tasks[0]?.task.title).toBe('使用备用方案');
        expect(result.planRevisions).toHaveLength(1);
        expect(result.planRevisions?.[0]?.diff.added).toEqual(['使用备用方案']);
        expect(replanReasons).toEqual(['model']);
        expect(await store.listTasks(target.goalId)).toHaveLength(2);
    });
});
