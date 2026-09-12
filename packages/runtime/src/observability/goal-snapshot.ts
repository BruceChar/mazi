/**
 * goal-snapshot —— Goal 树观测投影（C3f，OBS v1 的最小落地）。
 * 纯函数：goals/tasks/steps → 四元组（rootGoalId/goalId/taskId/stepId）层级快照，
 * 供审计/API/WebUI 消费；事实来自 GoalStore，本模块只投影不存储。
 *
 * 视图类型（GoalNodeView / TaskNodeView / StepView / GoalTreeSnapshot / StepUsage）
 * 已上移到 @mazi/libs，供 apps/api 与 apps/webui 共享；本文件仅保留投影函数。
 */

import type { Goal, Step, Task } from '@mazi/core';
import type { GoalNodeView, GoalTreeSnapshot, StepView, TaskNodeView } from '@mazi/libs';
import { usageViewOf } from './usage-view.js';

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
                .map((step) => {
                    const p = step.payload as unknown as Record<string, unknown> | undefined;
                    return {
                        stepId: step.stepId,
                        goalId: step.goalId,
                        taskId: step.taskId,
                        kind: step.kind,
                        status: step.status,
                        startedAt: step.startedAt,
                        ...(step.endedAt ? { endedAt: step.endedAt } : {}),
                        ...(p?.content
                            ? { content: String(p.content) }
                            : p?.output
                              ? { content: String(p.output) }
                              : {}),
                        ...(p?.toolName ? { toolName: String(p.toolName) } : {}),
                        ...(step.kind === 'tool_call' && p?.arguments !== undefined
                            ? { toolArguments: p.arguments as Record<string, unknown> }
                            : {}),
                        ...(step.kind === 'tool_call' && p?.cwd !== undefined
                            ? { toolCwd: String(p.cwd) }
                            : {}),
                        ...(step.kind === 'tool_call' && p?.output !== undefined
                            ? { toolOutput: String(p.output) }
                            : {}),
                        ...(payloadTextOf(step) !== undefined
                            ? { payloadText: payloadTextOf(step) }
                            : {}),
                        ...(usageViewOf(step.usage) !== undefined
                            ? { usage: usageViewOf(step.usage) }
                            : {}),
                    };
                });
            stepCount += stepViews.length;
            return {
                taskId: task.taskId,
                status: task.status,
                title: task.title,
                ...(task.startedAt !== undefined ? { startedAt: task.startedAt } : {}),
                ...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
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
