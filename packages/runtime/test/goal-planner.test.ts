import { describe, expect, it } from 'vitest';
import type { Goal } from '../../core/src/gts.js';
import { planGoalTree } from '../src/gts/goal-planner.js';
import { ULID, ulid } from '../../core/src/ulid.js';

function g(id: ULID, over: Partial<Goal> = {}): Goal {
    return {
        goalId: id,
        origin: { kind: 'human' },
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

describe('goal-planner（C3b：Goal → Task 最小规划，扁平模型）', () => {
    it('单 Goal → 产出单个 Task，验收派生自 successConditions', () => {
        const goal = g(ulid());
        const plan = planGoalTree({ goals: [goal] });
        expect(plan.rejected).toBeUndefined();
        expect(plan.goals.map((x) => x.goalId)).toEqual([goal.goalId]);
        expect(plan.tasks).toHaveLength(1);
        expect(plan.tasks[0]?.goalId).toBe(goal.goalId);
        expect(plan.tasks[0]?.acceptance.conditions).toContain(
            plan.tasks[0]?.acceptance.conditions[0],
        );
    });

    it('非 active Goal → 不产出计划（可执行 = status active）', () => {
        const pending = g(ulid(), { status: 'pending' });
        const plan = planGoalTree({ goals: [pending] });
        expect(plan.goals).toEqual([]);
        expect(plan.tasks).toEqual([]);
    });

    it('多个独立 Goal → 各产一 Task，带 plan 序号', () => {
        const a = g(ulid());
        const b = g(ulid());
        const plan = planGoalTree({ goals: [a, b] });
        expect(plan.goals.map((x) => x.goalId).sort()).toEqual([a.goalId, b.goalId]);
        expect(plan.tasks).toHaveLength(2);
        expect(plan.tasks.map((x) => x.goalId).sort()).toEqual([a.goalId, b.goalId]);
        expect(plan.tasks.every((x) => x.parentPlanNodeId !== undefined)).toBe(true);
    });
});
