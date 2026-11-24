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
        expect(result.loop?.nodeTrail?.some((node) => node.role === 'verify')).toBe(true);
        // 无工具调用：Think 产出最终回答后直接 Verify，不应虚报 Act。
        expect(result.loop?.nodeTrail?.some((node) => node.role === 'act')).toBe(false);
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
        expect(steps.every((step) => step.nodeId === 'think')).toBe(true);
        expect(steps.every((step) => step.nodeRole === 'think')).toBe(true);
        expect(steps.every((step) => step.agentRole === 'reasoner')).toBe(true);
        expect(steps.every((step) => step.nodeRunId?.startsWith('think:'))).toBe(true);
    });

    it('工具轮：think → act → observe → think → verify，Step 归属真实节点', async () => {
        const store = new MemoryGoalStore();
        const a = goal(ulid());
        await store.saveGoal(a);
        let round = 0;
        const result = await runGoalTreeDynamic(
            {
                store,
                allowedTools: ['fs.read'],
                invoker: { invoke: async () => ({ ok: true, content: 'CONTENT' }) },
                requestRound: async () => {
                    round += 1;
                    if (round === 1) {
                        return {
                            text: '',
                            reasoning: '先读文件',
                            toolCalls: [
                                { callId: 'c1', toolName: 'fs.read', arguments: { path: 'a' } },
                            ],
                            finishReason: 'tool_calls',
                            ttftMs: 0,
                            totalMs: 1,
                        };
                    }
                    return okRound;
                },
            },
            [a],
        );
        expect(result.ok).toBe(true);
        const roles = (result.loop?.nodeTrail ?? [])
            .filter((node) => node.kind === 'selected')
            .map((node) => node.role);
        expect(roles.slice(0, 4)).toEqual(['think', 'act', 'observe', 'think']);
        expect(roles).toContain('verify');
        const steps = await store.listSteps(result.tasks[0]!.task.taskId);
        const deliberation = steps.find((step) => step.kind === 'deliberation');
        const invocation = steps.find((step) => step.kind === 'invocation');
        expect(deliberation?.nodeId).toBe('think');
        expect(deliberation?.agentRole).toBe('reasoner');
        expect(invocation?.nodeId).toBe('act');
        expect(invocation?.agentRole).toBe('executor');
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
        expect(roles).toContain('verify');
    });


    it('节点上限提前终止时当前 Task 落 failed，不能停在 active', async () => {
        const store = new MemoryGoalStore();
        const a = goal(ulid());
        await store.saveGoal(a);
        let round = 0;
        const result = await runGoalTreeDynamic(
            {
                store,
                allowedTools: ['fs.read'],
                invoker: {
                    invoke: async () => ({ ok: true, content: `CONTENT-${round}` }),
                },
                requestRound: async () => {
                    round += 1;
                    return {
                        text: '',
                        reasoning: `第 ${round} 轮继续`,
                        toolCalls: [
                            {
                                callId: `c${round}`,
                                toolName: 'fs.read',
                                arguments: { path: `a-${round}` },
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
        expect(result.ok).toBe(false);
        expect(result.tasks).toHaveLength(1);
        const outcome = result.tasks[0]!;
        expect(outcome.ok).toBe(false);
        expect(outcome.reason).toBe('max-steps');
        expect(outcome.task.status).toBe('failed');
        const saved = await store.loadTask(outcome.task.taskId);
        expect(saved?.status).toBe('failed');
        expect(saved?.endedAt).toBeTypeOf('number');
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
