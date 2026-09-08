/**
 * goal-snapshot —— Goal 树观测投影（C3f，OBS v1 的最小落地）。
 * 纯函数：goals/tasks/steps → 四元组（rootGoalId/goalId/taskId/stepId）层级快照，
 * 供审计/API/WebUI 消费；事实来自 GoalStore，本模块只投影不存储。
 */

import type { Goal, Step, Task } from '@mazi/core';

export interface GoalNodeView {
    goalId: string;
    kind: 'intake' | 'work';
    status: Goal['status'];
    statement: string;
    tasks: TaskNodeView[];
}

export interface TaskNodeView {
    taskId: string;
    status: Task['status'];
    title: string;
    steps: StepView[];
}

export interface StepView {
    stepId: string;
    goalId: string;
    kind: Step['kind'];
    status: Step['status'];
    startedAt: number;
    /** payload 摘要（≤240 字符）：思考内容 / 工具名+参数 / 观察内容（审计与日志用） */
    payloadText?: string;
}

/** Step payload → 可读文本摘要（按 kind 投影；长内容截断） */
function payloadTextOf(step: Step): string | undefined {
    const payload = step.payload;
    const text =
        step.kind === 'thinking'
            ? ((payload as { content?: string }).content ?? '')
            : step.kind === 'tool_call'
              ? `${(payload as { toolName?: string }).toolName ?? ''} ${JSON.stringify(
                    (payload as { arguments?: unknown }).arguments ?? {},
                )}`
              : (() => {
                    const obs = payload as {
                        toolName?: string;
                        content?: string;
                        isError?: boolean;
                    };
                    return `${obs.toolName ? `[${obs.toolName}] ` : ''}${obs.content ?? ''}${
                        obs.isError ? ' ⚠' : ''
                    }`;
                })();
    return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

export interface GoalTreeSnapshot {
    rootGoalId: string;
    goals: GoalNodeView[];
    taskCount: number;
    stepCount: number;
}

export function snapshotGoalTree(
    rootGoalId: string,
    goals: Goal[],
    tasks: Task[],
    steps: Step[],
): GoalTreeSnapshot {
    const tasksByGoal = new Map<string, Task[]>();
    for (const task of tasks) {
        const list = tasksByGoal.get(task.goalId) ?? [];
        list.push(task);
        tasksByGoal.set(task.goalId, list);
    }
    const stepsByTask = new Map<string, Step[]>();
    for (const step of steps) {
        const list = stepsByTask.get(step.taskId) ?? [];
        list.push(step);
        stepsByTask.set(step.taskId, list);
    }
    const root = goals.find((g) => g.goalId === rootGoalId);
    const treeGoals = root
        ? [root, ...goals.filter((g) => g.rootGoalId === rootGoalId && g.goalId !== rootGoalId)]
        : goals.filter((g) => g.rootGoalId === rootGoalId);
    let taskCount = 0;
    let stepCount = 0;
    const views: GoalNodeView[] = treeGoals.map((goal) => {
        const taskViews: TaskNodeView[] = (tasksByGoal.get(goal.goalId) ?? []).map((task) => {
            const stepViews: StepView[] = (stepsByTask.get(task.taskId) ?? [])
                .slice()
                .sort((a, b) => a.startedAt - b.startedAt)
                .map((step) => ({
                    stepId: step.stepId,
                    goalId: step.goalId,
                    kind: step.kind,
                    status: step.status,
                    startedAt: step.startedAt,
                    ...(payloadTextOf(step) !== undefined
                        ? { payloadText: payloadTextOf(step) }
                        : {}),
                }));
            stepCount += stepViews.length;
            return {
                taskId: task.taskId,
                status: task.status,
                title: task.title,
                steps: stepViews,
            };
        });
        taskCount += taskViews.length;
        return {
            goalId: goal.goalId,
            kind: goal.kind,
            status: goal.status,
            statement: goal.statement,
            tasks: taskViews,
        };
    });
    return { rootGoalId, goals: views, taskCount, stepCount };
}
