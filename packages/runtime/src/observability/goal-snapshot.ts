/**
 * goal-snapshot —— Goal 会话观测投影（C3f，OBS v1 的最小落地）。
 * 纯函数：goals/tasks/steps → 四元组（rootGoalId/goalId/taskId/stepId）快照，
 * 供审计/API/WebUI 消费；事实来自 GoalStore，本模块只投影不存储。
 * 扁平模型：goals 为同一运行会话（rootGoalId）下的独立 Goal 集。
 *
 * 视图类型（GoalNodeView / TaskNodeView / StepView / GoalTreeSnapshot / StepUsage）
 * 已上移到 @mazi/libs，供 apps/api 与 apps/webui 共享；本文件仅保留投影函数。
 */

import type { Goal, Step, Task } from '@mazi/core';
import type { GoalNodeView, GoalTreeSnapshot, StepView, TaskNodeView } from '@mazi/libs';
import { usageViewOf } from './usage-view.js';

/** Step payload → 可读文本摘要（按 kind 投影；长内容截断） */
function payloadTextOf(step: Step): string | undefined {
    const text =
        step.kind === 'deliberation'
            ? [step.payload.thinking ?? '', step.payload.answer ?? '']
                  .filter((part) => part.length > 0)
                  .join(' ')
            : `${step.payload.toolName} ${JSON.stringify(step.payload.arguments ?? {})}`;
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
    let taskCount = 0;
    let stepCount = 0;
    const views: GoalNodeView[] = goals.map((goal) => {
        const taskViews: TaskNodeView[] = (tasksByGoal.get(goal.goalId) ?? []).map((task) => {
            const stepViews: StepView[] = (stepsByTask.get(task.taskId) ?? [])
                .slice()
                .sort((a, b) => a.startedAt - b.startedAt)
                .map((step) => {
                    const payloadText = payloadTextOf(step);
                    const kindFields =
                        step.kind === 'deliberation'
                            ? {
                                  ...((step.payload.answer ?? step.payload.thinking) !== undefined
                                      ? { content: step.payload.answer ?? step.payload.thinking }
                                      : {}),
                                  ...(step.payload.thinking !== undefined
                                      ? { thinking: step.payload.thinking }
                                      : {}),
                                  ...(step.payload.answer !== undefined
                                      ? { answer: step.payload.answer }
                                      : {}),
                              }
                            : {
                                  ...(step.payload.output !== undefined
                                      ? { content: step.payload.output }
                                      : {}),
                                  toolName: step.payload.toolName,
                                  toolArguments: step.payload.arguments,
                                  ...(step.payload.cwd !== undefined
                                      ? { toolCwd: step.payload.cwd }
                                      : {}),
                                  ...(step.payload.output !== undefined
                                      ? { toolOutput: step.payload.output }
                                      : {}),
                              };
                    return {
                        stepId: step.stepId,
                        goalId: step.goalId,
                        taskId: step.taskId,
                        kind: step.kind,
                        status: step.status,
                        startedAt: step.startedAt,
                        ...(step.endedAt ? { endedAt: step.endedAt } : {}),
                        ...kindFields,
                        ...(payloadText !== undefined ? { payloadText } : {}),
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
            status: goal.status,
            statement: goal.statement,
            tasks: taskViews,
        };
    });
    return { rootGoalId, goals: views, taskCount, stepCount };
}
