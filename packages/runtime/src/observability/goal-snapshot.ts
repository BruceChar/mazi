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
import type {
    AcceptanceView,
    ContractConditionView,
    ContractView,
    GoalNodeView,
    GoalTreeSnapshot,
    NegotiationView,
    StepView,
    TaskNodeView,
} from '@mazi/libs';
import { rollupAcceptance } from '../gts/acceptance.js';
import { usageViewOf } from './usage-view.js';

/** 条款投影：只搬运契约事实，不做解释（check 缺省表示尚无机械检查器）。 */
function conditionViewOf(condition: {
    id: string;
    checkType: 'deterministic' | 'semantic';
    description?: string;
    check?: { kind: 'final-answer' } | { kind: 'no-failed-steps' };
}): ContractConditionView {
    return {
        id: condition.id,
        checkType: condition.checkType,
        ...(condition.description !== undefined ? { description: condition.description } : {}),
        ...(condition.check !== undefined ? { check: condition.check } : {}),
    };
}

/** Goal.contract → 线协议视图；deterministicRatio 是「机械可判」健康度指标。 */
function contractViewOf(goal: Goal): ContractView {
    const success = goal.contract.successConditions;
    const deterministic = success.filter((item) => item.checkType === 'deterministic').length;
    return {
        successConditions: success.map(conditionViewOf),
        failureConditions: goal.contract.failureConditions.map(conditionViewOf),
        forbiddenResources: goal.contract.forbiddenResources.map((item) => ({
            kind: String(item.kind),
            pattern: item.pattern,
        })),
        budget: { ...goal.contract.budget },
        terminationPolicy: { ...goal.contract.terminationPolicy },
        riskProfile: { ...goal.contract.riskProfile },
        deterministicRatio: success.length === 0 ? 0 : deterministic / success.length,
    };
}

/** Goal.negotiation → 视图；缺省不输出（未协商的旧数据）。 */
function negotiationViewOf(goal: Goal): NegotiationView | undefined {
    const negotiation = goal.negotiation;
    if (negotiation === undefined) return undefined;
    return {
        route: negotiation.route,
        classifiedBy: negotiation.classifiedBy,
        triggers: [...negotiation.triggers],
        questions: negotiation.questions.map((question) => ({
            q: question.q,
            ...(question.why !== undefined ? { why: question.why } : {}),
            default: question.default,
        })),
        answers: negotiation.answers.map((answer) => ({
            q: answer.q,
            answer: answer.answer,
            ...(answer.usedDefault !== undefined ? { usedDefault: answer.usedDefault } : {}),
        })),
        revision: negotiation.revision,
        resolved: negotiation.resolved,
        at: negotiation.at,
        ...(negotiation.understanding !== undefined
            ? { understanding: [...negotiation.understanding] }
            : {}),
        ...(negotiation.defaultPath !== undefined
            ? { defaultPath: [...negotiation.defaultPath] }
            : {}),
        ...(negotiation.escalation !== undefined ? { escalation: negotiation.escalation } : {}),
        ...(negotiation.directAnswer !== undefined
            ? { directAnswer: negotiation.directAnswer }
            : {}),
    };
}

/** Task.acceptance → 视图（条款 id 数组，锚定契约）。 */
function acceptanceViewOf(task: Task): AcceptanceView {
    return {
        conditions: [...task.acceptance.conditions],
        ...(task.acceptance.aggregateConditions !== undefined
            ? { aggregateConditions: [...task.acceptance.aggregateConditions] }
            : {}),
        ...(task.acceptance.description !== undefined
            ? { description: task.acceptance.description }
            : {}),
    };
}

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
        const negotiation = negotiationViewOf(goal);
        const goalTasks = tasksByGoal.get(goal.goalId) ?? [];
        // Goal 级契约满足度：机械口径汇总（评估器视角，不等同于 executor 的成败）
        const contractStatus = rollupAcceptance(
            goal.contract.successConditions.map((condition) => condition.id),
            goalTasks.map((task) => task.acceptanceResult),
        );
        const taskViews: TaskNodeView[] = goalTasks.map((task) => {
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
                acceptance: acceptanceViewOf(task),
                ...(task.acceptanceResult !== undefined
                    ? {
                          acceptanceResult: {
                              ...task.acceptanceResult,
                              conditions: task.acceptanceResult.conditions.map((item) => ({
                                  ...item,
                              })),
                          },
                      }
                    : {}),
                steps: stepViews,
            };
        });
        taskCount += taskViews.length;
        return {
            goalId: goal.goalId,
            status: goal.status,
            statement: goal.statement,
            contract: contractViewOf(goal),
            ...(negotiation !== undefined ? { negotiation } : {}),
            contractStatus,
            tasks: taskViews,
        };
    });
    return { rootGoalId, goals: views, taskCount, stepCount };
}
