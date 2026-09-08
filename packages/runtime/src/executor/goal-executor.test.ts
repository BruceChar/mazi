import { describe, expect, it } from 'vitest';
import type { Goal, Task } from '../../../core/src/goal-coordinate.js';
import { MemoryGoalStore } from '../memory/goal-store.js';
import { executeTask } from './goal-executor.js';
import type { RoundResult } from './round-types.js';

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

    it('工具闭环：tool_call → 工具 → 观察 → 回注 → 最终回答（C5-1）', async () => {
        const store = new MemoryGoalStore();
        const seenToolRound = { value: false };
        const roundCalls: string[] = [];
        const toolRound: RoundResult = {
            text: '',
            reasoning: '',
            toolCalls: [{ callId: 'c1', toolName: 'fs.read', arguments: { path: '/tmp/a' } }],
            finishReason: 'tool_calls',
            ttftMs: 0,
            totalMs: 1,
        };
        const outcome = await executeTask(
            {
                store,
                allowedTools: ['fs.read'],
                invoker: {
                    invoke: async (name) => {
                        roundCalls.push(name);
                        return { ok: true, content: 'FILE CONTENT' };
                    },
                },
                requestRound: async (ctx) => {
                    if (!seenToolRound.value) {
                        seenToolRound.value = true;
                        return toolRound;
                    }
                    const hasTool = ctx.messages.some((m) => m.role === 'tool');
                    expect(hasTool).toBe(true); // 回注发生了
                    return okRound;
                },
            },
            task(),
            goal(),
        );
        expect(outcome.ok).toBe(true);
        expect(outcome.reason).toBe('final-answer');
        expect(roundCalls).toEqual(['fs.read']);
        const steps = await store.listSteps('t1');
        const kinds = steps.map((s) => s.kind);
        expect(kinds).toContain('tool_call');
        expect(kinds).toContain('observation');
        expect(kinds.filter((k) => k === 'thinking').length).toBe(2);
    });

    it('白名单外工具 → blocked-tool，工具不执行（C5-1）', async () => {
        const store = new MemoryGoalStore();
        let invoked = false;
        const outcome = await executeTask(
            {
                store,
                allowedTools: ['fs.read'],
                invoker: {
                    invoke: async () => {
                        invoked = true;
                        return { ok: true, content: '' };
                    },
                },
                requestRound: async () => ({
                    text: '',
                    reasoning: '',
                    toolCalls: [{ callId: 'x', toolName: 'fs.write', arguments: {} }],
                    finishReason: 'tool_calls',
                    ttftMs: 0,
                    totalMs: 1,
                }),
            },
            task(),
            goal(),
        );
        expect(outcome.ok).toBe(false);
        expect(outcome.reason).toBe('blocked-tool');
        expect(invoked).toBe(false);
    });
});
