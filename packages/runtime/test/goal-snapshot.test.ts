import { describe, expect, it } from 'vitest';
import type { Goal, Step, Task, ULID } from '@mazi/core';
import { ulid } from '@mazi/core';
import { snapshotGoalTree } from '../src/observability/goal-snapshot.js';

const goal = (id: ULID, rootId: ULID = id): Goal => ({
    goalId: id,
    rootGoalId: rootId,
    origin: { kind: 'human' },
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
    kind: 'deliberation',
    payload: { answer: 'x' },
    status: 'succeeded',
    startedAt: 1,
});

describe('goal-snapshot（C3f：四元组层级投影）', () => {
    it('intake+work → 树视图含 tasks/steps 计数', () => {
        const root = ulid();
        const intake = goal(root);
        const workA = goal(ulid(), root);
        const workB = goal(ulid(), root);
        const t1 = task(ulid(), workA.goalId);
        const t2 = task(ulid(), workB.goalId);
        const s1 = step(ulid(), t1.taskId, workA.goalId);
        const snap = snapshotGoalTree(root, [intake, workA, workB], [t1, t2], [s1]);
        expect(snap.goals).toHaveLength(3);
        expect(snap.taskCount).toBe(2);
        expect(snap.stepCount).toBe(1);
        expect(snap.goals[0]?.goalId).toBe(root);
        const nodeA = snap.goals.find((g) => g.goalId === workA.goalId);
        expect(nodeA?.tasks[0]?.taskId).toBe(t1.taskId);
        expect(nodeA?.tasks[0]?.steps[0]?.stepId).toBe(s1.stepId);
    });

    it('usage 投影：保留 vendor + runtime + cost + timing，缺省字段不输出', () => {
        const root = ulid();
        const intake = goal(root);
        const work = goal(ulid(), root);
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
                    historyUserTokens: 120,
                    historyAssistantTokens: 900,
                    toolCallTokens: 220,
                    toolSchemaTokens: 120,
                    newInputTokens: 80,
                    observationTokens: 200,
                    systemPromptRatio: 0.352,
                    contextWindowUtilization: 0.04,
                    contextDeltaFromPrev: 120,
                    strategyApplied: ['sliding-window'],
                    estimationDriftTokens: 15,
                    estimationDriftRate: 0.125,
                    contents: {
                        systemPrompt: 'sys',
                        historyUser: 'u',
                        historyAssistant: 'a',
                        toolCalls: '{}',
                        toolSchema: '[]',
                        newInput: 'hi',
                        observation: 'obs',
                        retrieved: '',
                        examples: '',
                    },
                    diffContent: '[user]\nhi',
                },
                estimate: {
                    outputTokens: 45,
                    outputDriftTokens: 10,
                    outputDriftRate: 0.286,
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
                estimatedCost: {
                    inputCostUsd: 0.0002,
                    outputCostUsd: 0.0004,
                    cacheWriteCostUsd: 0,
                    cacheReadCostUsd: 0,
                    reasoningCostUsd: 0,
                    totalCostUsd: 0.0006,
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
        expect(usage?.runtime?.historyUserTokens).toBe(120);
        expect(usage?.runtime?.historyAssistantTokens).toBe(900);
        expect(usage?.runtime?.toolCallTokens).toBe(220);
        expect(usage?.runtime?.estimationDriftRate).toBe(0.125);
        expect(usage?.runtime?.contents?.systemPrompt).toBe('sys');
        expect(usage?.runtime?.diffContent).toBe('[user]\nhi');
        expect(usage?.vendor?.totalTokens).toBe(165);
        expect(usage?.estimate?.outputTokens).toBe(45);
        expect(usage?.estimate?.outputDriftTokens).toBe(10);
        expect(usage?.cost?.totalCostUsd).toBeCloseTo(0.0012, 12);
        expect(usage?.cost?.priceTierApplied).toBe('off-peak');
        expect(usage?.estimatedCost?.totalCostUsd).toBeCloseTo(0.0006, 12);
        expect(usage?.timing?.tokensPerSecond).toBe(28);
        // 缺省字段不出现
        expect(usage?.vendor).not.toHaveProperty('cacheCreationInputTokens');
        expect(usage?.runtime).not.toHaveProperty('budgetPressureAction');
        expect(usage?.runtime).not.toHaveProperty('retrievedTokens');
    });

    it('invocation 投影：toolArguments 与 toolOutput 单独暴露（命令/参数/输出）', () => {
        const root = ulid();
        const work = goal(ulid(), root);
        const t = task(ulid(), work.goalId);
        const s: Step = {
            ...step(ulid(), t.taskId, work.goalId),
            kind: 'invocation',
            payload: {
                toolName: 'shell.run',
                arguments: { command: 'ls -la' },
                callId: 'c1',
                cwd: '/Users/bruce/.mazi',
                output: 'total 0',
            },
        };
        const snap = snapshotGoalTree(root, [work], [t], [s]);
        const view = snap.goals[0]?.tasks[0]?.steps[0];
        expect(view?.toolName).toBe('shell.run');
        expect(view?.toolArguments).toEqual({ command: 'ls -la' });
        expect(view?.toolCwd).toBe('/Users/bruce/.mazi');
        expect(view?.toolOutput).toBe('total 0');
        expect(view?.content).toBe('total 0');
    });

    it('usage 投影：roundId 透传（deliberation 轮聚合去重用）', () => {
        const root = ulid();
        const work = goal(ulid(), root);
        const t = task(ulid(), work.goalId);
        const s: Step = {
            ...step(ulid(), t.taskId, work.goalId),
            usage: { roundId: 'r1', vendor: { inputTokens: 1, outputTokens: 2, reportedByVendor: true } },
        };
        const snap = snapshotGoalTree(root, [work], [t], [s]);
        expect(snap.goals[0]?.tasks[0]?.steps[0]?.usage?.roundId).toBe('r1');
    });

    it('usage 缺失 → 不输出 usage 字段', () => {
        const root = ulid();
        const work = goal(ulid(), root);
        const t = task(ulid(), work.goalId);
        const s = step(ulid(), t.taskId, work.goalId);
        const snap = snapshotGoalTree(root, [work], [t], [s]);
        expect(snap.goals[0]?.tasks[0]?.steps[0]).not.toHaveProperty('usage');
    });

    it('契约投影：Goal.contract 全量 + deterministicRatio 健康度', () => {
        const root = ulid();
        const work = goal(ulid(), root);
        const conditionId = ulid();
        work.contract.successConditions = [
            {
                id: conditionId,
                checkType: 'deterministic',
                description: '产出最终回答',
                check: { kind: 'final-answer' },
            },
            { id: ulid(), checkType: 'semantic', description: '回答得体' },
        ];
        work.contract.budget = { maxCostUsd: 0.5 };
        work.contract.terminationPolicy = { maxSteps: 8 };
        work.contract.forbiddenResources = [{ kind: 'fs-glob', pattern: '/etc/**' }];
        const snap = snapshotGoalTree(root, [work], [task(ulid(), work.goalId)], []);
        const view = snap.goals[0]?.contract;
        expect(view?.successConditions).toHaveLength(2);
        expect(view?.successConditions[0]).toEqual({
            id: conditionId,
            checkType: 'deterministic',
            description: '产出最终回答',
            check: { kind: 'final-answer' },
        });
        expect(view?.deterministicRatio).toBe(0.5);
        expect(view?.budget.maxCostUsd).toBe(0.5);
        expect(view?.terminationPolicy.maxSteps).toBe(8);
        expect(view?.forbiddenResources).toEqual([{ kind: 'fs-glob', pattern: '/etc/**' }]);
        expect(view?.riskProfile.touchesNetwork).toBe(false);
    });

    it('验收投影：Task.acceptance 锚定条款；acceptanceResult 缺省时不输出', () => {
        const root = ulid();
        const work = goal(ulid(), root);
        const conditionId = ulid();
        const t = task(ulid(), work.goalId);
        t.acceptance = { conditions: [conditionId], description: 's' };
        const before = snapshotGoalTree(root, [work], [t], []);
        const taskView = before.goals[0]?.tasks[0];
        expect(taskView?.acceptance?.conditions).toEqual([conditionId]);
        expect(taskView?.acceptance?.description).toBe('s');
        expect(taskView).not.toHaveProperty('acceptanceResult');
        t.acceptanceResult = {
            checkedAt: 42,
            passed: true,
            evaluated: 1,
            total: 1,
            conditions: [{ conditionId, status: 'passed', detail: 'executor:final-answer' }],
        };
        const after = snapshotGoalTree(root, [work], [t], []);
        const result = after.goals[0]?.tasks[0]?.acceptanceResult;
        expect(result?.passed).toBe(true);
        expect(result?.evaluated).toBe(1);
        expect(result?.conditions[0]?.status).toBe('passed');
    });

    it('契约满足度：Goal 级汇总来自评估器判定（未执行 = unchecked，不谎报满足）', () => {
        const root = ulid();
        const work = goal(ulid(), root);
        const conditionId = ulid();
        work.contract.successConditions = [
            {
                id: conditionId,
                checkType: 'deterministic',
                description: '产出最终回答',
                check: { kind: 'final-answer' },
            },
            { id: ulid(), checkType: 'semantic', description: '命名得体' },
        ];
        const t = task(ulid(), work.goalId);

        // 未执行：没有任何机械判定 → unchecked
        const before = snapshotGoalTree(root, [work], [t], []);
        expect(before.goals[0]?.contractStatus?.state).toBe('unchecked');

        t.acceptanceResult = {
            checkedAt: 1,
            passed: true,
            evaluated: 1,
            total: 2,
            conditions: [
                { conditionId, status: 'passed' },
                { conditionId: ulid(), status: 'unchecked' },
            ],
        };
        const after = snapshotGoalTree(root, [work], [t], []);
        expect(after.goals[0]?.contractStatus).toEqual({
            state: 'partial',
            total: 2,
            evaluated: 1,
            passed: 1,
            failed: 0,
        });
    });

    it('Task 投影透传 planVersion（旧数据缺省不输出）', () => {
        const root = ulid();
        const work = goal(ulid(), root);
        const planned = { ...task(ulid(), work.goalId), planVersion: 2 };
        const legacy = task(ulid(), work.goalId);
        const snap = snapshotGoalTree(root, [work], [planned, legacy], []);
        const tasks = snap.goals[0]?.tasks ?? [];
        expect(tasks[0]?.planVersion).toBe(2);
        // 旧数据没有 planVersion：投影不输出该字段，UI 回退到「不过滤」。
        expect(tasks[1]).not.toHaveProperty('planVersion');
    });
});
