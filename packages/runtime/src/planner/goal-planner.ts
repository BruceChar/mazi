/**
 * goal-planner —— Goal → Task 最小规划（C3b）。
 * MVP：单个 work Goal → 单个 Task（验收由 goal.contract.successConditions 派生）；多意图切分、
 * Plan 图（parentPlanNodeId）留待后续。树级法律校验复用 goal-coordinate 纯函数。
 */

import {
    type AcceptanceSpec,
    type Goal,
    type Task,
    validateAttributionChain,
    validateCeilingMonotonicity,
} from '../../../core/src/goal-coordinate.js';

export interface PlanGoalTreeInput {
    /** 树节点：全部 Goal（含 intake/work/委托） */
    goals: Goal[];
}

export interface GoalPlan {
    /** 切分/委托后的可执行 work Goal（intake 已展开） */
    workGoals: Goal[];
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
 * 最小规划：接受一棵 Goal 树，产出可执行 work Goal 及其单任务 Task[]。
 * - 校验：法律1（链可达根）与法律2（ceiling/预算单调）任一失败 → 拒绝出计划；
 * - 一个 work Goal 产一个 Task（MVP；同一 Goal 内多 Task 依赖后续 Plan 图）。
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
        return { workGoals: [], tasks: [], rejected };
    }

    const workGoals = goals.filter((g) => g.kind === 'work' && g.status === 'active');
    const tasks: Task[] = workGoals.map((goal, i) => ({
        taskId: `task-${goal.goalId}`,
        goalId: goal.goalId,
        title: goal.statement.slice(0, 80),
        acceptance: acceptanceFrom(goal),
        status: 'pending',
        ...(workGoals.length > 1 ? { parentPlanNodeId: `plan-${i}` } : {}),
    }));
    return { workGoals, tasks };
}
