import { describe, expect, it } from 'vitest';
import type { Goal, Task } from '../../../core/src/goal-coordinate.js';
import { MemoryGoalStore } from '../memory/goal-store.js';
import type { RoundResult } from './executor.js';
import { executeTask } from './goal-executor.js';

function goal(): Goal {
    return {
        goalId: 'g1',
        rootGoalId: 'g1',
        origin: { kind: 'human' },
        kind: 'work',
        statement: '读取 README 并汇报',
        contract: {
            successConditions: [{ id: 'c1', checkType: 'deterministic' }],
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
function task(): Task {
    return {
        taskId: 't1',
        goalId: 'g1',
        title: '读取 README 并汇报',
        acceptance: { conditions: ['c1'] },
        status: 'pending',
    };
}
const okRound: RoundResult = {
    text: 'README 内容为 AHF 契约。',
    reasoning: '',
    toolCalls: [],
    finishReason: 'stop',
    ttftMs: 1,
    totalMs: 2,
};

describe('goal-executor（C3c：Task 单轮执行）', () => {
    it('执行产 thinking Step（归因 taskId/goalId）并持久化；Task 置 succeeded', async () => {
        const store = new MemoryGoalStore();
        const outcome = await executeTask(
            {
                store,
                requestRound: async () => okRound,
                systemPrompt: 'sys',
            },
            task(),
            goal(),
        );
        expect(outcome.ok).toBe(true);
        expect(outcome.reason).toBe('final-answer');
        expect(outcome.finalMessage).toContain('README');
        const steps = await store.listSteps('t1');
        expect(steps).toHaveLength(1);
        expect(steps[0]?.goalId).toBe('g1');
        expect(steps[0]?.kind).toBe('thinking');
        expect((await store.loadTask('t1'))?.status).toBe('succeeded');
    });

    it('requestRound 抛错 → driver-error，不落 Step', async () => {
        const store = new MemoryGoalStore();
        const outcome = await executeTask(
            {
                store,
                requestRound: async () => {
                    throw new Error('all providers failed');
                },
            },
            task(),
            goal(),
        );
        expect(outcome.ok).toBe(false);
        expect(outcome.reason).toBe('driver-error');
        expect(await store.listSteps('t1')).toEqual([]);
    });
});
