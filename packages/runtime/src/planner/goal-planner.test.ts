import { describe, expect, it } from 'vitest';
import type { Goal } from '../../../core/src/goal-coordinate.js';
import { planGoalTree } from './goal-planner.js';

function g(
    id: string,
    over: Partial<Goal> & { rootGoalId?: string; kind?: 'intake' | 'work' } = {},
): Goal {
    return {
        goalId: id,
        rootGoalId: over.rootGoalId ?? id,
        origin: { kind: 'human' },
        kind: over.kind ?? 'work',
        statement: '读取文件并汇报',
        contract: {
            successConditions: [{ id: 'cond-1', checkType: 'deterministic' }],
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
        ...over,
    };
}

describe('goal-planner（C3b：Goal → Task 最小规划）', () => {
    it('intake + work：产出单个 Task，验收派生自 successConditions', () => {
        const intake = g('intake', { kind: 'intake' });
        const work = g('w', { rootGoalId: 'intake' });
        const plan = planGoalTree({ goals: [intake, work] });
        expect(plan.rejected).toBeUndefined();
        expect(plan.workGoals.map((x) => x.goalId)).toEqual(['w']);
        expect(plan.tasks).toHaveLength(1);
        expect(plan.tasks[0]?.goalId).toBe('w');
        expect(plan.tasks[0]?.acceptance.conditions).toContain('cond-1');
    });

    it('孤儿 work（parent 引用的 Goal 缺失）→ 拒绝出计划', () => {
        const orphan = g('w', { rootGoalId: 'none', parent: { type: 'split', goalId: 'missing' } });
        const plan = planGoalTree({ goals: [orphan] });
        expect(plan.workGoals).toEqual([]);
        expect(plan.rejected?.[0]).toContain('parent');
    });

    it('多 work 兄弟（同 intake 切分）→ 每 Goal 一 Task，带 plan 序号', () => {
        const intake = g('intake', { kind: 'intake' });
        const a = g('a', { rootGoalId: 'intake' });
        const b = g('b', { rootGoalId: 'intake' });
        const plan = planGoalTree({ goals: [intake, a, b] });
        expect(plan.tasks).toHaveLength(2);
        expect(plan.tasks.map((x) => x.goalId).sort()).toEqual(['a', 'b']);
        expect(plan.tasks.every((x) => x.parentPlanNodeId !== undefined)).toBe(true);
    });
});
