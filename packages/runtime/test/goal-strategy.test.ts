import { describe, expect, it } from 'vitest';
import type { Goal, ULID } from '@mazi/core';
import { ulid } from '@mazi/core';
import type { RoundResult } from '../src/gts/round-types.js';
import { MemoryGoalStore } from '../src/memory/goal-store.js';
import { MemoryManager } from '../src/memory/memory.js';
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

    it('工具执行记录为 memory fact，并注入后续 Goal 的 system prompt', async () => {
        const store = new MemoryGoalStore();
        const a = goal(ulid());
        const b = goal(ulid());
        await store.saveGoal(a);
        await store.saveGoal(b);
        const memory = new MemoryManager();
        const prompts: Array<string | undefined> = [];
        let round = 0;
        await runGoalTree(
            {
                store,
                memory,
                allowedTools: ['noop'],
                invoker: { invoke: async () => ({ ok: true, content: 'TOOL-OUT' }) },
                requestRound: async (ctx) => {
                    prompts.push(ctx.systemPrompt);
                    round += 1;
                    if (round === 1) {
                        return {
                            text: '',
                            reasoning: '',
                            toolCalls: [{ callId: 'c1', toolName: 'noop', arguments: { x: 1 } }],
                            finishReason: 'tool_calls',
                            ttftMs: 0,
                            totalMs: 1,
                        };
                    }
                    return okRound;
                },
            },
            [a, b],
        );
        const items = await memory.recall({ rootGoalId: a.goalId });
        expect(items.some((item) => item.kind === 'fact' && item.text.includes('noop'))).toBe(true);
        expect(prompts[2]).toContain('noop');
    });

    it('契约终止策略生效：terminationPolicy.maxSteps 覆盖 executor 默认 50', async () => {
        const store = new MemoryGoalStore();
        const a = goal(ulid());
        a.contract.terminationPolicy = { maxSteps: 2 };
        await store.saveGoal(a);
        let rounds = 0;
        const result = await runGoalTree(
            {
                store,
                allowedTools: ['noop'],
                invoker: { invoke: async () => ({ ok: true, content: 'OUT' }) },
                requestRound: async () => {
                    rounds += 1;
                    return {
                        text: '',
                        reasoning: '',
                        toolCalls: [
                            {
                                callId: `c${rounds}`,
                                toolName: 'noop',
                                arguments: { n: rounds },
                            },
                        ],
                        finishReason: 'tool_calls',
                        ttftMs: 0,
                        totalMs: 1,
                    };
                },
            },
            [a],
        );
        expect(rounds).toBe(2);
        expect(result.tasks[0]?.reason).toBe('max-steps');
    });

    it('契约预算生效：累计 round.cost 达上限即停（budget-exceeded）', async () => {
        const store = new MemoryGoalStore();
        const a = goal(ulid());
        a.contract.budget = { maxCostUsd: 0.01 };
        await store.saveGoal(a);
        let rounds = 0;
        const result = await runGoalTree(
            {
                store,
                allowedTools: ['noop'],
                invoker: { invoke: async () => ({ ok: true, content: 'OUT' }) },
                requestRound: async () => {
                    rounds += 1;
                    return {
                        text: '',
                        reasoning: '',
                        toolCalls: [
                            {
                                callId: `c${rounds}`,
                                toolName: 'noop',
                                arguments: { n: rounds },
                            },
                        ],
                        finishReason: 'tool_calls',
                        ttftMs: 0,
                        totalMs: 1,
                        cost: {
                            inputCostUsd: 0,
                            outputCostUsd: 0,
                            cacheWriteCostUsd: 0,
                            cacheReadCostUsd: 0,
                            reasoningCostUsd: 0,
                            totalCostUsd: 0.02,
                            priceTierApplied: 'standard',
                            pricingVersion: 'v1',
                            currency: 'USD',
                            calculatedAt: 1,
                        },
                    };
                },
            },
            [a],
        );
        expect(rounds).toBe(1);
        expect(result.tasks[0]?.reason).toBe('budget-exceeded');
    });

    it('执行后写入验收判定事实（评估器随 Task 落库）', async () => {
        const store = new MemoryGoalStore();
        const a = goal(ulid());
        await store.saveGoal(a);
        const result = await runGoalTree({ store, requestRound: async () => okRound }, [a]);
        const saved = await store.loadTask(result.tasks[0]!.task.taskId);
        expect(saved?.acceptanceResult?.total).toBe(1);
        expect(saved?.acceptanceResult?.evaluated).toBe(0);
        expect(saved?.acceptanceResult?.conditions[0]?.status).toBe('unchecked');
        expect(saved?.acceptanceResult?.passed).toBe(true);
    });

    it('按依赖拓扑执行分层 Task，并在执行前拒绝越权计划', async () => {
        const store = new MemoryGoalStore();
        const a = goal(ulid());
        await store.saveGoal(a);
        const condition = a.contract.successConditions[0]!.id;
        const calls: string[] = [];
        const result = await runGoalTree(
            {
                store,
                requestRound: async () => {
                    calls.push('round');
                    return okRound;
                },
                planProposal: [
                    {
                        key: 'inspect',
                        goalId: a.goalId,
                        title: '检查',
                        acceptanceConditionIds: [condition],
                    },
                    {
                        key: 'verify',
                        goalId: a.goalId,
                        title: '验证',
                        dependsOn: ['inspect'],
                        acceptanceConditionIds: [condition],
                    },
                ],
            },
            [a],
        );
        expect(result.ok).toBe(true);
        expect(result.tasks.map((outcome) => outcome.task.title)).toEqual(['检查', '验证']);
        expect(calls).toHaveLength(2);
        expect(result.tasks[0]?.task.dependsOn).toEqual([]);
        expect(result.tasks[1]?.task.dependsOn).toEqual([result.tasks[0]?.task.taskId]);

        const rejected = await runGoalTree(
            {
                store: new MemoryGoalStore(),
                requestRound: async () => okRound,
                planProposal: [
                    {
                        key: 'escalate',
                        goalId: a.goalId,
                        title: '越权',
                        permissionCeiling: 'autonomous',
                        acceptanceConditionIds: [condition],
                    },
                ],
            },
            [a],
        );
        expect(rejected.ok).toBe(false);
        expect(rejected.rejected?.join('\n')).toContain('权限超过 Goal 上限');
    });

    it('resume 对尚未生成 Task 的 active Goal 补建计划而不是空跑', async () => {
        const store = new MemoryGoalStore();
        const a = goal(ulid());
        await store.saveGoal(a);
        const result = await runGoalTree(
            { store, resume: true, requestRound: async () => okRound },
            [a],
        );
        expect(result.tasks).toHaveLength(1);
        expect((await store.listTasks(a.goalId))[0]?.taskId).toBe(result.tasks[0]?.task.taskId);
    });
});
