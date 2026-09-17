import { describe, expectTypeOf, it } from 'vitest';
import type { Goal, Step, Task } from '../src/gts.js';

describe('Goal 扁平契约（2026-09-17：intent 直接产 Goal，无树结构）', () => {
    it('Goal 保留意图/契约/治理字段', () => {
        expectTypeOf<Goal>().toHaveProperty('goalId');
        expectTypeOf<Goal>().toHaveProperty('origin');
        expectTypeOf<Goal>().toHaveProperty('statement');
        expectTypeOf<Goal>().toHaveProperty('contract');
        expectTypeOf<Goal>().toHaveProperty('permissionCeiling');
        expectTypeOf<Goal>().toHaveProperty('budget');
        expectTypeOf<Goal>().toHaveProperty('status');
    });

    it('Goal 不再含 rootGoalId / parent（树字段随扁平化移除）', () => {
        expectTypeOf<Goal>().not.toHaveProperty('rootGoalId');
        expectTypeOf<Goal>().not.toHaveProperty('parent');
    });

    it('Task 唯一归属 Goal；Step 锚定 Task+Goal', () => {
        expectTypeOf<Task>().toHaveProperty('goalId');
        expectTypeOf<Step>().toHaveProperty('taskId');
        expectTypeOf<Step>().toHaveProperty('goalId');
    });
});
