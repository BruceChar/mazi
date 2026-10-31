/**
 * plan-graph —— executable task DAG and preflight validation.
 *
 * The model may propose tasks, but it never decides whether a plan is valid.
 * This module checks graph shape, budgets, permission inheritance, tool supply
 * and acceptance references before the executor can touch external state.
 */

import type { BudgetAllocation, Goal, PermissionLevel, Task, ULID } from '@mazi/core';
import { ulid } from '@mazi/core';

export interface PlannedTask {
    /** Stable key local to the proposal; remapped to a Task ULID after compilation. */
    key: string;
    /** Omitted for a single-root session; the harness fills it from rootGoalId. */
    goalId?: ULID;
    title: string;
    dependsOn?: readonly string[];
    /** Must reference successConditions owned by the same Goal. */
    acceptanceConditionIds?: readonly ULID[];
    permissionCeiling?: PermissionLevel;
    budget?: BudgetAllocation;
    requiredTools?: readonly string[];
}

export interface PlanTool {
    name: string;
    minPermission: PermissionLevel;
}

export interface PlanGraph {
    planId: ULID;
    version: number;
    rootGoalId: ULID;
    tasks: Task[];
    /** Stable digest of ordered task facts; useful for replay and diffing. */
    digest: string;
}

export interface PlanValidation {
    ok: boolean;
    rejected: string[];
}

export interface CompilePlanInput {
    goals: readonly Goal[];
    proposals?: readonly PlannedTask[];
    availableTools?: readonly PlanTool[];
    planVersion?: number;
    id?: () => ULID;
    digest?: (tasks: readonly Task[]) => string;
}

const LEVEL_RANK: Record<PermissionLevel, number> = {
    text: 0,
    'read-only': 1,
    'workspace-write': 2,
    draft: 3,
    approved: 4,
    autonomous: 5,
};

function sumCost(tasks: readonly Task[]): number {
    return tasks.reduce((sum, task) => sum + (task.budget?.maxCostUsd ?? 0), 0);
}

function cycleNodes(tasks: readonly Task[]): string[] {
    const byId = new Map(tasks.map((task) => [task.taskId, task]));
    const state = new Map<string, 'visiting' | 'done'>();
    const cycle = new Set<string>();

    const visit = (id: ULID): void => {
        if (state.get(id) === 'done') return;
        if (state.get(id) === 'visiting') {
            cycle.add(id);
            return;
        }
        state.set(id, 'visiting');
        for (const dependency of byId.get(id)?.dependsOn ?? []) {
            visit(dependency);
        }
        state.set(id, 'done');
    };

    for (const task of tasks) visit(task.taskId);
    return [...cycle];
}

/** Mechanical validation shared by the planner and resume path. */
export function validatePlanGraph(
    goals: readonly Goal[],
    tasks: readonly Task[],
    availableTools?: readonly PlanTool[],
): PlanValidation {
    const rejected: string[] = [];
    const goalById = new Map(goals.map((goal) => [goal.goalId, goal]));
    const taskById = new Map(tasks.map((task) => [task.taskId, task]));
    if (taskById.size !== tasks.length) rejected.push('taskId 必须唯一');

    for (const task of tasks) {
        const goal = goalById.get(task.goalId);
        if (goal === undefined) {
            rejected.push(`Task ${task.taskId} 不属于计划中的 Goal`);
            continue;
        }
        const ceiling = task.permissionCeiling ?? goal.permissionCeiling;
        if (LEVEL_RANK[ceiling] > LEVEL_RANK[goal.permissionCeiling]) {
            rejected.push(`Task ${task.taskId} 权限超过 Goal 上限`);
        }
        for (const dependency of task.dependsOn ?? []) {
            if (!taskById.has(dependency)) {
                rejected.push(`Task ${task.taskId} 依赖不存在的节点 ${dependency}`);
            }
        }
        for (const condition of task.acceptance.conditions) {
            if (!goal.contract.successConditions.some((item) => item.id === condition)) {
                rejected.push(`Task ${task.taskId} 验收条件 ${condition} 不在 Goal 契约中`);
            }
        }
        for (const toolName of task.requiredTools ?? []) {
            const tool = availableTools?.find((item) => item.name === toolName);
            if (availableTools !== undefined && tool === undefined) {
                rejected.push(`Task ${task.taskId} 需要未注册工具 ${toolName}`);
            } else if (tool !== undefined && LEVEL_RANK[tool.minPermission] > LEVEL_RANK[ceiling]) {
                rejected.push(`Task ${task.taskId} 所需工具 ${toolName} 超出权限上限`);
            }
        }
    }

    const cycles = cycleNodes(tasks);
    if (cycles.length > 0) rejected.push(`计划存在环：${cycles.join(',')}`);

    for (const goal of goals) {
        const children = tasks.filter((task) => task.goalId === goal.goalId);
        if (
            goal.budget.maxCostUsd !== undefined &&
            sumCost(children) > goal.budget.maxCostUsd + Number.EPSILON
        ) {
            rejected.push(`Goal ${goal.goalId} 子 Task 成本预算之和超过父预算`);
        }
        for (const task of children) {
            const taskCost = task.budget?.maxCostUsd;
            if (
                taskCost !== undefined &&
                goal.budget.maxCostUsd !== undefined &&
                taskCost > goal.budget.maxCostUsd + Number.EPSILON
            ) {
                rejected.push(`Task ${task.taskId} 单项预算超过 Goal 预算`);
            }
        }
    }

    return { ok: rejected.length === 0, rejected };
}

/**
 * Deterministic topological order. Stable insertion order breaks ties so
 * replay does not depend on Map iteration accidents or wall-clock time.
 */
export function topologicalTaskOrder(tasks: readonly Task[]): Task[] {
    const byId = new Map(tasks.map((task) => [task.taskId, task]));
    const pending = new Set(tasks.map((task) => task.taskId));
    const ordered: Task[] = [];
    while (pending.size > 0) {
        const ready = tasks.find(
            (task) =>
                pending.has(task.taskId) &&
                (task.dependsOn ?? []).every((dependency) => !pending.has(dependency)),
        );
        if (ready === undefined) {
            throw new Error(`计划存在环：${[...pending].join(',')}`);
        }
        pending.delete(ready.taskId);
        const readyTask = byId.get(ready.taskId);
        if (readyTask !== undefined) ordered.push(readyTask);
    }
    return ordered;
}

function defaultDigest(tasks: readonly Task[]): string {
    const value = tasks
        .map((task) => ({
            taskId: task.taskId,
            goalId: task.goalId,
            title: task.title,
            dependsOn: task.dependsOn ?? [],
            acceptance: task.acceptance.conditions,
            permissionCeiling: task.permissionCeiling,
            budget: task.budget ?? {},
            requiredTools: task.requiredTools ?? [],
        }))
        .sort((a, b) => a.taskId.localeCompare(b.taskId));
    // FNV-1a is sufficient here as a stable plan fingerprint; authorization
    // integrity uses the signed DecisionLog/hash-chain path separately.
    let hash = 0x811c9dc5;
    for (const char of JSON.stringify(value)) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Compile a task proposal into executable Tasks. Returned `rejected` is a
 * hard stop: callers must not execute a partial graph when validation fails.
 */
export function compileTaskPlan(input: CompilePlanInput): {
    graph?: PlanGraph;
    tasks: Task[];
    validation: PlanValidation;
} {
    const activeGoals = input.goals.filter((goal) => goal.status === 'active');
    const proposals: readonly PlannedTask[] =
        input.proposals ??
        activeGoals.map((goal) => ({
            key: goal.goalId,
            goalId: goal.goalId,
            title: goal.statement.slice(0, 80),
            acceptanceConditionIds: goal.contract.successConditions.map((item) => item.id),
        }));
    const id = input.id ?? ulid;
    const keyToTask = new Map<string, ULID>();
    const base = proposals.map((proposal) => {
        const taskId = id();
        keyToTask.set(proposal.key, taskId);
        return { proposal, taskId };
    });
    const goalById = new Map(input.goals.map((goal) => [goal.goalId, goal]));
    const tasks: Task[] = base.map(({ proposal, taskId }) => {
        const goalId = proposal.goalId ?? activeGoals[0]?.goalId ?? input.goals[0]?.goalId;
        const goal = goalId !== undefined ? goalById.get(goalId) : undefined;
        return {
            taskId,
            goalId: goalId ?? ('' as ULID),
            title: proposal.title,
            acceptance: {
                conditions:
                    proposal.acceptanceConditionIds !== undefined
                        ? [...proposal.acceptanceConditionIds]
                        : (goal?.contract.successConditions.map((item) => item.id) ?? []),
                ...(goal?.statement !== undefined ? { description: goal.statement } : {}),
            },
            status: 'pending',
            dependsOn: (proposal.dependsOn ?? [])
                .map((key) => keyToTask.get(key))
                .filter((value): value is ULID => value !== undefined),
            permissionCeiling: proposal.permissionCeiling ?? goal?.permissionCeiling ?? 'read-only',
            budget: proposal.budget ?? {},
            requiredTools: [...(proposal.requiredTools ?? [])],
            planVersion: input.planVersion ?? 1,
        };
    });
    const validation = validatePlanGraph(activeGoals, tasks, input.availableTools);
    if (!validation.ok) return { tasks, validation };
    const rootGoalId = activeGoals[0]?.goalId ?? input.goals[0]?.goalId ?? ('' as ULID);
    return {
        tasks,
        validation,
        graph: {
            planId: id(),
            version: input.planVersion ?? 1,
            rootGoalId,
            tasks,
            digest: (input.digest ?? defaultDigest)(tasks),
        },
    };
}
