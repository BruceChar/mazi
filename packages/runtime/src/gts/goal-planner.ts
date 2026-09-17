/**
 * goal-planner —— Goal → Task 最小规划（C3b）。
 * 扁平模型：user intent 直接产 Goal，Goal 相互独立（无树/无 parent）；
 * MVP：单个 Goal → 单个 Task（验收由 goal.contract.successConditions 派生）；多 Task 依赖后续 Plan 图。
 */

import { type AcceptanceSpec, type Goal, type Task, ulid } from '@mazi/core';

export interface PlanGoalTreeInput {
    /** 扁平 Goal 集（无树结构；每个 goal 独立，intent 直接产生） */
    goals: Goal[];
}

export interface GoalPlan {
    /** 可执行 Goal */
    goals: Goal[];
    tasks: Task[];
}

/** 从 goal.contract 机械成功条件派生 Task 验收（checkType='semantic' 项需 judge，暂以条件 id 占位） */
function acceptanceFrom(goal: Goal): AcceptanceSpec {
    const conditions = goal.contract.successConditions.map((c) => c.id);
    return {
        conditions,
        description: goal.statement,
        ...(conditions.length === 0 ? { conditions: [`goal-${goal.goalId}-satisfied`] } : {}),
    };
}

/**
 * 最小规划：接受扁平 Goal 集，产出可执行 Goal 及其单任务 Task[]。
 * - 可执行 = status active（无树结构，不再需要叶子判定）；
 * - 一个可执行 Goal 产一个 Task（MVP；同一 Goal 内多 Task 依赖后续 Plan 图）。
 */
export function planGoalTree(input: PlanGoalTreeInput): GoalPlan {
    const { goals } = input;
    const executable = goals.filter((g) => g.status === 'active');
    const tasks: Task[] = executable.map((goal, i) => ({
        taskId: ulid(),
        goalId: goal.goalId,
        title: goal.statement.slice(0, 80),
        acceptance: acceptanceFrom(goal),
        status: 'pending',
        ...(executable.length > 1 ? { parentPlanNodeId: `plan-${i}` } : {}),
    }));
    return { goals: executable, tasks };
}
