import { describe, expect, it } from 'vitest';
import type { Goal, Step, Task, ULID } from '@mazi/core';
import { ulid } from '@mazi/core';
import { snapshotGoalTree } from '../src/observability/goal-snapshot.js';

const goal = (id: ULID, kind: 'intake' | 'work' = 'work', rootId: ULID = id): Goal => ({
    goalId: id,
    rootGoalId: rootId,
    origin: { kind: 'human' },
    kind,
    statement: `s-${id}`,
    contract: {
        successConditions: [],
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
});
const task = (id: ULID, goalId: ULID): Task => ({
    taskId: id,
    goalId,
    title: `t-${id}`,
    acceptance: { conditions: [] },
    status: 'pending',
});
const step = (id: ULID, taskId: ULID, goalId: ULID): Step => ({
    stepId: id,
    taskId,
    goalId,
    kind: 'thinking',
    payload: { content: 'x' },
    status: 'ok',
    startedAt: 1,
});

describe('goal-snapshot（C3f：四元组层级投影）', () => {
    it('intake+work → 树视图含 tasks/steps 计数', () => {
        const root = ulid();
        const intake = goal(root, 'intake', root);
        const workA = goal(ulid(), 'work', root);
        const workB = goal(ulid(), 'work', root);
        const t1 = task(ulid(), workA.goalId);
        const t2 = task(ulid(), workB.goalId);
        const s1 = step(ulid(), t1.taskId, workA.goalId);
        const snap = snapshotGoalTree(root, [intake, workA, workB], [t1, t2], [s1]);
        expect(snap.goals).toHaveLength(3);
        expect(snap.taskCount).toBe(2);
        expect(snap.stepCount).toBe(1);
        expect(snap.goals[0]?.kind).toBe('intake');
        const nodeA = snap.goals.find((g) => g.goalId === workA.goalId);
        expect(nodeA?.tasks[0]?.taskId).toBe(t1.taskId);
        expect(nodeA?.tasks[0]?.steps[0]?.stepId).toBe(s1.stepId);
    });

    it('usage 投影：保留 vendor + runtime + cost + timing，缺省字段不输出', () => {
        const root = ulid();
        const intake = goal(root, 'intake', root);
        const work = goal(ulid(), 'work', root);
        const t = task(ulid(), work.goalId);
        const s: Step = {
            ...step(ulid(), t.taskId, work.goalId),
            usage: {
                vendor: {
                    inputTokens: 120,
                    outputTokens: 45,
                    cacheReadInputTokens: 2100,
                    reasoningOutputTokens: 10,
                    reportedByVendor: true,
                },
                runtime: {
                    totalContextTokens: 2530,
                    systemPromptTokens: 890,
                    historyTokens: 1240,
                    toolSchemaTokens: 120,
                    newInputTokens: 80,
                    observationTokens: 200,
                    systemPromptRatio: 0.352,
                    contextWindowUtilization: 0.04,
                    contextDeltaFromPrev: 120,
                    strategyApplied: ['sliding-window'],
                    estimationDriftTokens: 15,
                },
                cost: {
                    inputCostUsd: 0.0003,
                    outputCostUsd: 0.0005,
                    cacheWriteCostUsd: 0,
                    cacheReadCostUsd: 0.0004,
                    reasoningCostUsd: 0,
                    totalCostUsd: 0.0012,
                    priceTierApplied: 'off-peak',
                    pricingVersion: 'v1',
                    currency: 'USD',
                },
                timing: { ttftMs: 180, totalMs: 420, tokensPerSecond: 28 },
            },
        };
        const snap = snapshotGoalTree(root, [intake, work], [t], [s]);
        const usage = snap.goals.find((g) => g.goalId === work.goalId)?.tasks[0]?.steps[0]?.usage;
        expect(usage?.vendor?.inputTokens).toBe(120);
        expect(usage?.vendor?.cacheReadInputTokens).toBe(2100);
        expect(usage?.runtime?.contextDeltaFromPrev).toBe(120);
        expect(usage?.runtime?.contextWindowUtilization).toBe(0.04);
        expect(usage?.runtime?.strategyApplied).toEqual(['sliding-window']);
        expect(usage?.cost?.totalCostUsd).toBeCloseTo(0.0012, 12);
        expect(usage?.cost?.priceTierApplied).toBe('off-peak');
        expect(usage?.timing?.tokensPerSecond).toBe(28);
        // 缺省字段不出现
        expect(usage?.vendor).not.toHaveProperty('cacheCreationInputTokens');
        expect(usage?.runtime).not.toHaveProperty('budgetPressureAction');
        expect(usage?.runtime).not.toHaveProperty('retrievedTokens');
    });

    it('usage 缺失 → 不输出 usage 字段', () => {
        const root = ulid();
        const work = goal(ulid(), 'work', root);
        const t = task(ulid(), work.goalId);
        const s = step(ulid(), t.taskId, work.goalId);
        const snap = snapshotGoalTree(root, [work], [t], [s]);
        expect(snap.goals[0]?.tasks[0]?.steps[0]).not.toHaveProperty('usage');
    });
});
