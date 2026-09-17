/**
 * goal-planner —— Goal → Task 最小规划（C3b）。
 * MVP：单个 Goal → 单个 Task（验收由 goal.contract.successConditions 派生）；多意图切分、
 * Plan 图（parentPlanNodeId）留待后续。树级法律校验复用 goal-coordinate 纯函数。
 */

import {
    type AcceptanceSpec,
    type Goal,
    type Task,
    ulid,
    validateAttributionChain,
    validateCeilingMonotonicity,
} from '@mazi/core';

export interface PlanGoalTreeInput {
    /** 树节点：全部 Goal（含根与委托） */
    goals: Goal[];
}

export interface GoalPlan {
    /** 通过法律校验的可执行 Goal */
    goals: Goal[];
    tasks: Task[];
    rejected?: string[];
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
 * 最小规划：接受一棵 Goal 树，产出可执行叶子 Goal 及其单任务 Task[]。
 * - 校验：法律1（链可达根）与法律2（ceiling/预算单调）任一失败 → 拒绝出计划；
 * - 「可执行」= status active 且未被任何 Goal 作为 parent 引用（叶子）；
 *   根在无子节点时本身就是叶子（已取消 intake/work 标签）；
 * - 一个可执行 Goal 产一个 Task（MVP；同一 Goal 内多 Task 依赖后续 Plan 图）。
 */
export function planGoalTree(input: PlanGoalTreeInput): GoalPlan {
    const { goals } = input;
    const index = new Map(goals.map((g) => [g.goalId, g]));

    const rejected: string[] = [];
    for (const goal of goals) {
        const chain = validateAttributionChain(goal, index);
        if (!chain.ok) {
            rejected.push(chain.reason);
        }
    }
    const mono = validateCeilingMonotonicity(goals, index);
    if (!mono.ok) {
        rejected.push(mono.reason);
    }
    if (rejected.length > 0) {
        return { goals: [], tasks: [], rejected };
    }

    const parentIds = new Set(goals.flatMap((g) => (g.parent ? [g.parent.goalId] : [])));
    const executable = goals.filter((g) => g.status === 'active' && !parentIds.has(g.goalId));
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
