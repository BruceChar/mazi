import { describe, expect, it } from 'vitest';
import type { Goal } from '../../../core/src/gts.js';
import { planGoalTree } from './goal-planner.js';
import { ULID, ulid } from '../../../core/src/id.js';

function g(
    id: ULID,
    over: Partial<Goal> & { rootGoalId?: string; kind?: 'intake' | 'work' } = {},
): Goal {
    return {
        goalId: id,
        rootGoalId: over.rootGoalId ?? id,
        origin: { kind: 'human' },
        kind: over.kind ?? 'work',
        statement: '读取文件并汇报',
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
        ...over,
    };
}

describe('goal-planner（C3b：Goal → Task 最小规划）', () => {
    it('intake + work：产出单个 Task，验收派生自 successConditions', () => {
        const intake = g(ulid(), { kind: 'intake' });
        const work = g(ulid(), { rootGoalId: intake.goalId });
        const plan = planGoalTree({ goals: [intake, work] });
        expect(plan.rejected).toBeUndefined();
        expect(plan.workGoals.map((x) => x.goalId)).toEqual([work.goalId]);
        expect(plan.tasks).toHaveLength(1);
        expect(plan.tasks[0]?.goalId).toBe(work.goalId);
        expect(plan.tasks[0]?.acceptance.conditions).toContain(plan.tasks[0]?.acceptance.conditions[0]);
    });

    it('孤儿 work（parent 引用的 Goal 缺失）→ 拒绝出计划', () => {
        const orphan = g(ulid());
        const plan = planGoalTree({ goals: [orphan] });
        expect(plan.workGoals).toEqual([]);
        expect(plan.rejected?.[0]).toContain('parent');
    });

    it('多 work 兄弟（同 intake 切分）→ 每 Goal 一 Task，带 plan 序号', () => {
        const intake = g(ulid(), { kind: 'intake' });
        const a = g(ulid(), { rootGoalId: intake.goalId });
        const b = g(ulid(), { rootGoalId: intake.goalId });
        const plan = planGoalTree({ goals: [intake, a, b] });
        expect(plan.tasks).toHaveLength(2);
        expect(plan.tasks.map((x) => x.goalId).sort()).toEqual([a.goalId, b.goalId]);
        expect(plan.tasks.every((x) => x.parentPlanNodeId !== undefined)).toBe(true);
    });
});
