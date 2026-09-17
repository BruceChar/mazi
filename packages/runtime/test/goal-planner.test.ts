import { describe, expect, it } from 'vitest';
import type { Goal } from '../../core/src/gts.js';
import { planGoalTree } from '../src/gts/goal-planner.js';
import { ULID, ulid } from '../../core/src/id.js';

function g(
    id: ULID,
    over: Partial<Goal> & { rootGoalId?: string } = {},
): Goal {
    return {
        goalId: id,
        rootGoalId: over.rootGoalId ?? id,
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

describe('goal-planner（C3b：Goal → Task 最小规划）', () => {
    it('单 Goal（叶子）→ 产出单个 Task，验收派生自 successConditions', () => {
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

    it('parent 引用的 Goal 缺失 → 拒绝出计划', () => {
        const orphan = g(ulid());
        orphan.parent = { type: 'split', goalId: ulid() };
        const plan = planGoalTree({ goals: [orphan] });
        expect(plan.goals).toEqual([]);
        expect(plan.rejected?.[0]).toContain('not found');
    });

    it('多叶子兄弟（同 parent 切分）→ 每叶子一 Task，带 plan 序号', () => {
        const root = g(ulid());
        const a = g(ulid(), {
            rootGoalId: root.goalId,
            parent: { type: 'split', goalId: root.goalId },
        });
        const b = g(ulid(), {
            rootGoalId: root.goalId,
            parent: { type: 'split', goalId: root.goalId },
        });
        const plan = planGoalTree({ goals: [root, a, b] });
        expect(plan.goals.map((x) => x.goalId).sort()).toEqual([a.goalId, b.goalId]);
        expect(plan.tasks).toHaveLength(2);
        expect(plan.tasks.map((x) => x.goalId).sort()).toEqual([a.goalId, b.goalId]);
        expect(plan.tasks.every((x) => x.parentPlanNodeId !== undefined)).toBe(true);
    });
});
