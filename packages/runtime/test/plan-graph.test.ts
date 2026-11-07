import type { Goal } from '@mazi/core';
import { ulid } from '@mazi/core';
import { describe, expect, it } from 'vitest';

import {
    compileTaskPlan,
    topologicalTaskOrder,
    validatePlanGraph,
} from '../src/gts/plan-graph.js';

function goal(over: Partial<Goal> = {}): Goal {
    const condition = ulid();
    return {
        goalId: ulid(),
        origin: { kind: 'human' },
        statement: '分层完成任务',
        contract: {
            successConditions: [
                { id: condition, checkType: 'deterministic', check: { kind: 'final-answer' } },
            ],
            failureConditions: [],
            forbiddenResources: [],
            budget: { maxCostUsd: 10 },
            terminationPolicy: {},
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
        ...over,
    };
}

describe('plan graph', () => {
    it('compiles a DAG and returns stable topological order', () => {
        const target = goal();
        const condition = target.contract.successConditions[0]!.id;
        const ids = [ulid(), ulid(), ulid()];
        let cursor = 0;
        const compiled = compileTaskPlan({
            goals: [target],
            proposals: [
                {
                    key: 'inspect',
                    goalId: target.goalId,
                    title: '检查',
                    acceptanceConditionIds: [condition],
                    budget: { maxCostUsd: 2 },
                    requiredTools: ['rg'],
                },
                {
                    key: 'edit',
                    goalId: target.goalId,
                    title: '修改',
                    dependsOn: ['inspect'],
                    acceptanceConditionIds: [condition],
                    budget: { maxCostUsd: 3 },
                    requiredTools: ['sd'],
                },
                {
                    key: 'verify',
                    goalId: target.goalId,
                    title: '验证',
                    dependsOn: ['edit'],
                    acceptanceConditionIds: [condition],
                    budget: { maxCostUsd: 2 },
                    requiredTools: ['shell.run'],
                },
            ],
            availableTools: [
                { name: 'rg', minPermission: 'read-only' },
                { name: 'sd', minPermission: 'workspace-write' },
                { name: 'shell.run', minPermission: 'workspace-write' },
            ],
            id: () => ids[cursor++]!,
        });

        expect(compiled.validation.ok).toBe(true);
        expect(compiled.graph?.digest).toMatch(/^[0-9a-f]{8}$/);
        expect(topologicalTaskOrder(compiled.tasks).map((task) => task.title)).toEqual([
            '检查',
            '修改',
            '验证',
        ]);
    });

    it('rejects cycles, budget overflow, unknown tools and permission escalation', () => {
        const target = goal();
        target.contract.terminationPolicy.maxSteps = 4;
        const condition = target.contract.successConditions[0]!.id;
        const ids = [ulid(), ulid(), ulid()];
        let cursor = 0;
        const compiled = compileTaskPlan({
            goals: [target],
            proposals: [
                {
                    key: 'a',
                    goalId: target.goalId,
                    title: 'A',
                    dependsOn: ['b'],
                    acceptanceConditionIds: [condition],
                    permissionCeiling: 'autonomous',
                    budget: { maxCostUsd: 8, maxSteps: 3 },
                    requiredTools: ['host.x'],
                },
                {
                    key: 'b',
                    goalId: target.goalId,
                    title: 'B',
                    dependsOn: ['a'],
                    acceptanceConditionIds: [condition],
                    budget: { maxCostUsd: 8, maxSteps: 3 },
                },
                {
                    key: 'c',
                    goalId: target.goalId,
                    title: 'C',
                    acceptanceConditionIds: [ulid()],
                    budget: { maxCostUsd: 1 },
                },
            ],
            availableTools: [],
            id: () => ids[cursor++]!,
        });

        expect(compiled.validation.ok).toBe(false);
        expect(compiled.validation.rejected.join('\n')).toContain('计划存在环');
        expect(compiled.validation.rejected.join('\n')).toContain('权限超过 Goal 上限');
        expect(compiled.validation.rejected.join('\n')).toContain('成本预算之和超过父预算');
        expect(compiled.validation.rejected.join('\n')).toContain('轮次预算之和超过父预算');
        expect(compiled.validation.rejected.join('\n')).toContain('未注册工具');
        expect(compiled.validation.rejected.join('\n')).toContain('不在 Goal 契约中');
    });

    it('resume validation operates on persisted tasks without creating new ids', () => {
        const target = goal();
        const condition = target.contract.successConditions[0]!.id;
        const taskId = ulid();
        const tasks = [
            {
                taskId,
                goalId: target.goalId,
                title: 'one',
                acceptance: { conditions: [condition] },
                status: 'active' as const,
                permissionCeiling: 'read-only' as const,
            },
        ];
        expect(validatePlanGraph([target], tasks).ok).toBe(true);
    });
});
