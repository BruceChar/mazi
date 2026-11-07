import type { BudgetAllocation, Goal, Task } from '@mazi/core';
import type { VerificationFailureCategory, VerificationReport } from '../verifier/index.js';
import type { TaskOutcome } from './goal-executor.js';
import {
    compileTaskPlan,
    type PlannedTask,
    type PlanTool,
    validatePlanGraph,
} from './plan-graph.js';
import { parseTaskPlan } from './task-planner.js';

export interface ReplanRequest {
    goal: Goal;
    revision: number;
    completedTasks: readonly Task[];
    failedTask: Task;
    failureReason: string;
    failureCategory?: VerificationFailureCategory;
    evidence: readonly string[];
    remainingBudget: BudgetAllocation;
}

export type ReplanPlanner = (request: ReplanRequest) => Promise<readonly PlannedTask[] | undefined>;

export interface ReplanOption {
    planner: ReplanPlanner;
    availableTools?: readonly PlanTool[];
    maxReplans?: number;
}


/** Replan 最多提出的新 Task 数（失败后只补剩余工作，避免重排整个计划）。 */
export const DEFAULT_MAX_REPLAN_TASKS = 4;

/** Replan Planner 提示词：在保留已完成 Task 的前提下，为失败补一个新的 Task 计划。 */
export function buildReplanPlannerPrompt(request: ReplanRequest): string {
    const conditions = request.goal.contract.successConditions
        .map((condition) => condition.description ?? condition.id)
        .join('；');
    const completed =
        request.completedTasks.length > 0
            ? request.completedTasks
                  .map((task) => `- ${task.title}（${task.status}）`)
                  .join('\n')
            : '（无）';
    const evidence = request.evidence
        .slice(0, 6)
        .map((item) => `- ${item.slice(0, 600)}`)
        .join('\n');
    return [
        '你是 Replan Planner。上一个 Task 未通过验收，请只规划**剩余未完成的工作**。',
        `Task 数量 1-${DEFAULT_MAX_REPLAN_TASKS}；已完成并保留的 Task 不要重复。`,
        '根据失败原因与证据修正做法；可以拆成多个可独立验收的 Task，用 dependsOn 表达顺序。',
        '每个 Task 必须是一个完整工作单元，动作导向 title，可独立验收。',
        'requiredTools 可省略；dependsOn 只能引用本次输出中更早的 key。',
        '严格输出 JSON，不输出 markdown：',
        '{"tasks":[{"key":"fix","title":"修复失败原因","dependsOn":[],"requiredTools":[]}]}',
        '',
        `目标：${request.goal.statement}`,
        `Goal 成功条件：${conditions || '（无额外条件）'}`,
        `已完成 Task：\n${completed}`,
        `失败 Task：${request.failedTask.title}`,
        `失败原因：${request.failureReason}`,
        ...(request.failureCategory !== undefined
            ? [`失败分类：${request.failureCategory}`]
            : []),
        ...(evidence.length > 0 ? [`证据：\n${evidence}`] : []),
        `剩余预算：${JSON.stringify(request.remainingBudget)}`,
    ].join('\n');
}

/** LLM Replan Planner：完成回调由宿主注入（与 Task Planner 同款），解析失败返回 undefined。 */
export function createLlmReplanPlanner(
    complete: (prompt: string) => Promise<string>,
): ReplanPlanner {
    return async (request) =>
        parseTaskPlan(
            await complete(buildReplanPlannerPrompt(request)),
            request.goal,
            DEFAULT_MAX_REPLAN_TASKS,
        );
}


export interface PlanDiff {
    added: string[];
    removed: string[];
    retained: string[];
}

export interface PlanRevision {
    revision: number;
    tasks: Task[];
    diff: PlanDiff;
    digest: string;
    reason: string;
    evidence: string[];
    createdAt: number;
}

export interface ReplanResult {
    revision?: PlanRevision;
    rejected?: string[];
}

function contractHash(goal: Goal): string {
    return JSON.stringify(goal.contract);
}

function taskDigest(tasks: readonly Task[]): string {
    const normalized = tasks
        .map((task) => ({
            title: task.title,
            goalId: task.goalId,
            dependsOn: task.dependsOn ?? [],
            acceptance: task.acceptance.conditions,
            budget: task.budget ?? {},
            permissionCeiling: task.permissionCeiling,
            requiredTools: task.requiredTools ?? [],
        }))
        .sort((left, right) => left.title.localeCompare(right.title));
    return JSON.stringify(normalized);
}

function sumCost(tasks: readonly Task[]): number {
    return tasks.reduce((sum, task) => sum + (task.budget?.maxCostUsd ?? 0), 0);
}

export async function createPlanRevision(input: {
    request: ReplanRequest;
    proposal: readonly PlannedTask[];
    availableTools?: readonly PlanTool[];
    priorDigests?: readonly string[];
    now?: () => number;
}): Promise<ReplanResult> {
    const contractBefore = contractHash(input.request.goal);
    const completed = input.request.completedTasks.filter((task) => task.status === 'succeeded');
    const compiled = compileTaskPlan({
        goals: [input.request.goal],
        proposals: input.proposal,
        ...(input.availableTools !== undefined ? { availableTools: input.availableTools } : {}),
        planVersion: input.request.revision + 1,
    });
    const rejected = [...compiled.validation.rejected];
    if (contractHash(input.request.goal) !== contractBefore) rejected.push('Replan 修改了冻结契约');
    if (compiled.tasks.length === 0) rejected.push('Replan 未产生任何 Task');
    if (
        sumCost(compiled.tasks) >
        (input.request.remainingBudget.maxCostUsd ?? Number.POSITIVE_INFINITY) + Number.EPSILON
    ) {
        rejected.push('Replan 预算超过剩余预算');
    }
    const nextTasks = [...completed, ...compiled.tasks];
    rejected.push(
        ...validatePlanGraph([input.request.goal], nextTasks, input.availableTools).rejected,
    );
    const digest = taskDigest(nextTasks);
    if (input.priorDigests?.includes(digest) === true) rejected.push('Replan 产生重复计划');
    if (rejected.length > 0) return { rejected: [...new Set(rejected)] };
    const completedIds = new Set(completed.map((task) => task.taskId));
    const newIds = new Set(compiled.tasks.map((task) => task.taskId));
    return {
        revision: {
            revision: input.request.revision + 1,
            tasks: nextTasks,
            diff: {
                added: compiled.tasks.map((task) => task.title),
                removed: [input.request.failedTask.title].filter(
                    (title) => !compiled.tasks.some((task) => task.title === title),
                ),
                retained: completed
                    .filter((task) => completedIds.has(task.taskId) && !newIds.has(task.taskId))
                    .map((task) => task.title),
            },
            digest,
            reason: `verifier:${input.request.failureReason}`,
            evidence: [...input.request.evidence],
            createdAt: (input.now ?? Date.now)(),
        },
    };
}

export function failureFromOutcome(
    outcome: TaskOutcome,
    verification?: VerificationReport,
): {
    failureReason: string;
    failureCategory?: VerificationFailureCategory;
    evidence: string[];
} {
    return {
        failureReason: verification?.state ?? outcome.reason,
        ...(verification?.failureCategory !== undefined
            ? { failureCategory: verification.failureCategory }
            : {}),
        evidence: verification?.evidence ?? [
            ...(outcome.errorMessage !== undefined ? [outcome.errorMessage] : []),
        ],
    };
}
