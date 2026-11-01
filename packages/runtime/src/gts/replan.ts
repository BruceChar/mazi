import type { BudgetAllocation, Goal, Task } from '@mazi/core';
import type { VerificationFailureCategory, VerificationReport } from '../verifier/index.js';
import type { TaskOutcome } from './goal-executor.js';
import {
    compileTaskPlan,
    type PlannedTask,
    type PlanTool,
    validatePlanGraph,
} from './plan-graph.js';

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
