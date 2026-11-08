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
    /** 0-based 轮次：第一次 Replan 为 0；PlanRevision.revision = revision + 1。 */
    revision: number;
    completedTasks: readonly Task[];
    failedTask: Task;
    /**
     * 原计划中尚未执行、仍然有效的 Task（pending/active，排除已完成的与本次失败的 Task）。
     * 这些 Task 必须被新 revision 原样保留（同一 taskId），Replan 只能为失败补补救 Task。
     */
    remainingTasks: readonly Task[];
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

/** Replan Planner 提示词：保留已完成/未执行的 Task，只为失败补一个补救 Task 计划。 */
export function buildReplanPlannerPrompt(request: ReplanRequest): string {
    const conditions = request.goal.contract.successConditions
        .map((condition) => condition.description ?? condition.id)
        .join('；');
    const completed =
        request.completedTasks.length > 0
            ? request.completedTasks.map((task) => `- ${task.title}（${task.status}）`).join('\n')
            : '（无）';
    const remaining =
        request.remainingTasks.length > 0
            ? request.remainingTasks.map((task) => `- ${task.title}（${task.status}）`).join('\n')
            : '（无）';
    const evidence = request.evidence
        .slice(0, 6)
        .map((item) => `- ${item.slice(0, 600)}`)
        .join('\n');
    return [
        '你是 Replan Planner。上一个 Task 未通过验收，请只规划**失败 Task 的补救工作**，不要重排整个计划。',
        `Task 数量 1-${DEFAULT_MAX_REPLAN_TASKS}；已完成并保留的 Task 不要重复。`,
        '原计划中尚未执行、仍然有效的 Task 必须保留，不要重复规划；新 Task 不得与已完成或这些剩余 Task 重复，边界必须清晰、互不重叠。',
        '根据失败原因与证据修正做法；可以拆成多个可独立验收的 Task，用 dependsOn 表达顺序。',
        '每个 Task 必须是一个完整工作单元，动作导向 title，可独立验收。',
        'requiredTools 可省略；dependsOn 只能引用本次输出中更早的 key。',
        '严格输出 JSON，不输出 markdown：',
        '{"tasks":[{"key":"fix","title":"修复失败原因","dependsOn":[],"requiredTools":[]}]}',
        '',
        `目标：${request.goal.statement}`,
        `Goal 成功条件：${conditions || '（无额外条件）'}`,
        `已完成 Task：\n${completed}`,
        `原计划中尚未执行、仍然有效的 Task（必须保留，不要重复规划）：\n${remaining}`,
        `失败 Task：${request.failedTask.title}`,
        `失败原因：${request.failureReason}`,
        ...(request.failureCategory !== undefined ? [`失败分类：${request.failureCategory}`] : []),
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
    /** PlanRevision 序号：1 = 第一次 Replan。 */
    revision: number;
    /** 计划版本：初始计划 = 1；PlanRevision.revision = N 时 planVersion = N + 1。 */
    planVersion: number;
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
    const failedTaskId = input.request.failedTask.taskId;
    const carriedRemaining = input.request.remainingTasks.filter(
        (task) => task.taskId !== failedTaskId,
    );
    // 计划版本：初始计划 = 1；第 N 次 Replan（PlanRevision.revision = N）产出 planVersion = N + 1。
    const planVersion = input.request.revision + 2;
    const compiled = compileTaskPlan({
        goals: [input.request.goal],
        proposals: input.proposal,
        ...(input.availableTools !== undefined ? { availableTools: input.availableTools } : {}),
        planVersion,
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
    // 保留已完成 Task 与「尚未执行但仍有效」的 Task（同一 taskId 带入新 revision）。
    // 依赖重映射：remaining 若依赖本次失败的 Task，改为依赖本 revision 的全部补救 Task，
    // 保证拓扑顺序为「先补救、后执行原计划的剩余工作」，且不留下悬空依赖。
    const remediationIds = compiled.tasks.map((task) => task.taskId);
    const remapDependencies = (task: Task): Task => {
        const remapped = task.dependsOn?.flatMap((dependency) =>
            dependency === failedTaskId ? remediationIds : [dependency],
        );
        return {
            ...task,
            planVersion,
            ...(remapped !== undefined ? { dependsOn: [...new Set(remapped)] } : {}),
        };
    };
    const retained = [...completed, ...carriedRemaining].map(remapDependencies);
    const nextTasks = [...retained, ...compiled.tasks];
    rejected.push(
        ...validatePlanGraph([input.request.goal], nextTasks, input.availableTools).rejected,
    );
    const digest = taskDigest(nextTasks);
    if (input.priorDigests?.includes(digest) === true) rejected.push('Replan 产生重复计划');
    if (rejected.length > 0) return { rejected: [...new Set(rejected)] };
    const newIds = new Set(compiled.tasks.map((task) => task.taskId));
    return {
        revision: {
            revision: input.request.revision + 1,
            planVersion,
            tasks: nextTasks,
            diff: {
                added: compiled.tasks.map((task) => task.title),
                removed: [input.request.failedTask.title].filter(
                    (title) => !compiled.tasks.some((task) => task.title === title),
                ),
                retained: retained
                    .filter((task) => !newIds.has(task.taskId))
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
