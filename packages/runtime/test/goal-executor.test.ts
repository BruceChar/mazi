import { describe, expect, it } from 'vitest';
import type { Goal, Task } from '../../core/src/gts.js';
import { MemoryGoalStore } from '../src/memory/goal-store.js';
import { executeTask } from '../src/gts/goal-executor.js';
import type { RoundResult } from '../src/gts/round-types.js';
import { ulid } from '../../core/src/id.js';

function goal(): Goal {
    return {
        goalId: ulid(),
        rootGoalId: ulid(),
        origin: { kind: 'human' },
        kind: 'work',
        statement: '读取 README 并汇报',
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
function task(): Task {
    return {
        taskId: ulid(),
        goalId: ulid(),
        title: '读取 README 并汇报',
        acceptance: { conditions: ['c1'] },
        status: 'pending',
    };
}
const okRound: RoundResult = {
    text: 'README 内容为 AHF 契约。',
    reasoning: '先读取 README，再总结其内容。',
    toolCalls: [],
    finishReason: 'stop',
    ttftMs: 1,
    totalMs: 2,
};

describe('goal-executor（C3c：Task 单轮执行）', () => {
    it('执行产 thinking + intent Step（推理与模型输出分离）并持久化；Task 置 succeeded', async () => {
        const store = new MemoryGoalStore();
        const t = task();
        const g = goal();
        const outcome = await executeTask(
            {
                store,
                requestRound: async () => okRound,
                systemPrompt: 'sys',
            },
            t,
            g,
        );
        expect(outcome.ok).toBe(true);
        expect(outcome.reason).toBe('final-answer');
        expect(outcome.finalMessage).toContain('README');
        const steps = await store.listSteps(t.taskId);
        expect(steps).toHaveLength(2);
        expect(steps[0]?.goalId).toBe(t.goalId);
        expect(steps[0]?.kind).toBe('thinking');
        expect(steps[1]?.kind).toBe('intent');
        expect((await store.loadTask(t.taskId))?.status).toBe('succeeded');
    });

    it('执行前先落库 running Task：进行中的 task/step 可被 timeline 观测', async () => {
        const store = new MemoryGoalStore();
        const t = task();
        const g = goal();
        let duringRun: Task[] = [];
        await executeTask(
            {
                store,
                requestRound: async () => {
                    duringRun = await store.listTasks(t.goalId);
                    return okRound;
                },
            },
            t,
            g,
        );
        expect(duringRun.map((x) => x.taskId)).toContain(t.taskId);
        expect(duringRun[0]?.status).toBe('running');
    });

    it('requestRound 抛错 → driver-error，不落 Step', async () => {
        const store = new MemoryGoalStore();
        const t = task();
        const g = goal();
        const outcome = await executeTask(
            {
                store,
                requestRound: async () => {
                    throw new Error('all providers failed');
                },
            },
            t,
            g,
        );
        expect(outcome.ok).toBe(false);
        expect(outcome.reason).toBe('driver-error');
        expect(await store.listSteps(t.taskId)).toEqual([]);
    });

    it('工具闭环：tool_call → 工具 → 观察 → 回注 → 最终回答（C5-1）', async () => {
        const store = new MemoryGoalStore();
        const seenToolRound = { value: false };
        const roundCalls: string[] = [];
        const t = task();
        const g = goal();
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
            t,
            g,
        );
        expect(outcome.ok).toBe(true);
        expect(outcome.reason).toBe('final-answer');
        expect(roundCalls).toEqual(['fs.read']);
        const steps = await store.listSteps(t.taskId);
        const kinds = steps.map((s) => s.kind);
        expect(kinds).toContain('tool_call');
        expect(kinds).not.toContain('observation');
        const toolStep = steps.find((s) => s.kind === 'tool_call');
        expect(toolStep?.payload).toHaveProperty('output');
        expect(kinds.filter((k) => k === 'thinking').length).toBe(1);
        expect(kinds.filter((k) => k === 'intent').length).toBe(1);
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

    it('usage 归属：vendor/runtime/cost/timing 挂到本轮首个 Step，后续 Step 不带', async () => {
        const store = new MemoryGoalStore();
        const t = task();
        const g = goal();
        const round: RoundResult = {
            text: 'answer',
            reasoning: 'think',
            toolCalls: [],
            finishReason: 'stop',
            ttftMs: 100,
            totalMs: 300,
            vendorUsage: { inputTokens: 10, outputTokens: 20, reportedByVendor: true },
            cost: {
                inputCostUsd: 0.001,
                outputCostUsd: 0.002,
                cacheWriteCostUsd: 0,
                cacheReadCostUsd: 0,
                reasoningCostUsd: 0,
                totalCostUsd: 0.003,
                priceTierApplied: 'base',
                pricingVersion: 'v1',
                currency: 'USD',
                calculatedAt: 1,
            },
        };
        await executeTask({ store, requestRound: async () => round }, t, g);
        const steps = await store.listSteps(t.taskId);
        const thinking = steps.find((s) => s.kind === 'thinking');
        const intent = steps.find((s) => s.kind === 'intent');
        const usage = thinking?.usage as {
            timing?: { tokensPerSecond?: number };
            cost?: { totalCostUsd?: number };
            vendor?: { inputTokens?: number };
        };
        expect(usage?.vendor?.inputTokens).toBe(10);
        expect(usage?.timing?.tokensPerSecond).toBeCloseTo((20 / 200) * 1000, 6);
        expect(usage?.cost?.totalCostUsd).toBeCloseTo(0.003, 12);
        expect(intent?.usage).toBeUndefined();
    });

    it('连续相同工具调用 → 未收敛中止（防死循环，不烧完 maxSteps）', async () => {
        const store = new MemoryGoalStore();
        let calls = 0;
        const outcome = await executeTask(
            {
                store,
                allowedTools: ['fs.read'],
                invoker: {
                    invoke: async () => {
                        calls += 1;
                        return { ok: true, content: 'SAME' };
                    },
                },
                requestRound: async () => ({
                    text: '',
                    reasoning: '',
                    toolCalls: [{ callId: 'c', toolName: 'fs.read', arguments: { path: 'a' } }],
                    finishReason: 'tool_calls',
                    ttftMs: 0,
                    totalMs: 1,
                }),
                maxSteps: 50,
            },
            task(),
            goal(),
        );
        expect(outcome.ok).toBe(false);
        expect(outcome.reason).toBe('max-steps');
        expect(outcome.errorMessage).toContain('未收敛');
        expect(calls).toBeLessThan(10);
    });
});
