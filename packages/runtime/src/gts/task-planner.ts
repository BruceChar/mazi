import type { Goal } from '@mazi/core';
import {
    DEFAULT_GOAL_MAX_STEPS,
    effectiveGoalLimits,
    type PlannedTask,
    type PlanTool,
} from './plan-graph.js';

export const DEFAULT_MAX_PLAN_TASKS = 6;

export interface TaskPlanningInput {
    goal: Goal;
    availableTools: readonly PlanTool[];
    sessionContext?: string;
    maxTasks?: number;
}

export type TaskPlanner = (input: TaskPlanningInput) => Promise<readonly PlannedTask[] | undefined>;

interface TaskProposalJson {
    key?: unknown;
    title?: unknown;
    dependsOn?: unknown;
    requiredTools?: unknown;
}

function stringList(value: unknown): string[] | undefined {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        return undefined;
    }
    return [...new Set(value)].map((item) => item.trim()).filter((item) => item.length > 0);
}

function extractJsonObject(raw: string): string | undefined {
    const start = raw.indexOf('{');
    if (start < 0) return undefined;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < raw.length; index += 1) {
        const char = raw[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') inString = true;
        else if (char === '{') depth += 1;
        else if (char === '}') {
            depth -= 1;
            if (depth === 0) return raw.slice(start, index + 1);
        }
    }
    return undefined;
}

/** Parse the model proposal strictly enough that malformed output falls back to one Task. */
export function parseTaskPlan(
    raw: string,
    goal: Goal,
    maxTasks = DEFAULT_MAX_PLAN_TASKS,
): PlannedTask[] | undefined {
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        const extracted = extractJsonObject(raw);
        if (extracted === undefined) return undefined;
        try {
            value = JSON.parse(extracted);
        } catch {
            return undefined;
        }
    }
    if (typeof value !== 'object' || value === null) return undefined;
    const tasks = (value as { tasks?: unknown }).tasks;
    if (!Array.isArray(tasks) || tasks.length === 0) return undefined;
    const taskLimit = Math.max(1, Math.floor(maxTasks));
    if (tasks.length > taskLimit) return undefined;
    const acceptanceConditionIds = goal.contract.successConditions.map((condition) => condition.id);
    const proposals: PlannedTask[] = [];
    const keys = new Set<string>();
    for (const value of tasks) {
        if (typeof value !== 'object' || value === null) return undefined;
        const item = value as TaskProposalJson;
        const key = typeof item.key === 'string' ? item.key.trim() : '';
        const title = typeof item.title === 'string' ? item.title.trim() : '';
        if (
            !/^[A-Za-z0-9_-]+$/.test(key) ||
            title.length === 0 ||
            keys.has(key) ||
            title.length > 160
        ) {
            return undefined;
        }
        const dependsOn = item.dependsOn === undefined ? [] : stringList(item.dependsOn);
        const requiredTools =
            item.requiredTools === undefined ? [] : stringList(item.requiredTools);
        if (dependsOn === undefined || requiredTools === undefined) return undefined;
        keys.add(key);
        proposals.push({
            key,
            goalId: goal.goalId,
            title,
            dependsOn,
            acceptanceConditionIds,
            requiredTools,
        });
    }
    if (proposals.some((proposal) => proposal.dependsOn?.some((key) => !keys.has(key)))) {
        return undefined;
    }
    return proposals;
}

/** Divide the Goal envelope so child Tasks cannot each consume the whole budget. */
export function allocateTaskBudgets(goal: Goal, proposals: readonly PlannedTask[]): PlannedTask[] {
    const count = proposals.length;
    if (count === 0) return [];
    const limits = effectiveGoalLimits(goal);
    const maxCostUsd = limits.maxCostUsd;
    const maxSteps = limits.maxSteps ?? DEFAULT_GOAL_MAX_STEPS;
    const totalSteps = maxSteps > 0 ? Math.max(count, Math.floor(maxSteps)) : undefined;
    return proposals.map((proposal, index) => {
        const cost =
            maxCostUsd !== undefined && maxCostUsd > 0
                ? (maxCostUsd * (index + 1)) / count - (maxCostUsd * index) / count
                : undefined;
        const steps =
            totalSteps !== undefined
                ? Math.floor((totalSteps * (index + 1)) / count) -
                  Math.floor((totalSteps * index) / count)
                : undefined;
        return {
            ...proposal,
            budget: {
                ...(cost !== undefined ? { maxCostUsd: cost } : {}),
                ...(steps !== undefined ? { maxSteps: Math.max(1, Math.floor(steps)) } : {}),
            },
        };
    });
}

export function buildTaskPlannerPrompt(input: TaskPlanningInput): string {
    const maxTasks = input.maxTasks ?? DEFAULT_MAX_PLAN_TASKS;
    const limits = effectiveGoalLimits(input.goal);
    const tools = input.availableTools
        .map((tool) => `${tool.name}(${tool.minPermission})`)
        .join(', ');
    return [
        '你是 Task Planner。把用户目标拆成可独立执行、可验收的 Task DAG。',
        `Task 数量 1-${maxTasks}。简单目标只生成 1 个 Task，不要为了形式拆步骤。`,
        '只在存在清晰阶段、不同产物或前后依赖时拆分；不要把每个工具调用拆成 Task。',
        '每个 Task 必须是一个完整工作单元，并使用简短、动作导向的 title。',
        '执行器每次只完成当前 Task；依赖 Task 的产物会通过前置结果提供，不要提前完成后续阶段。',
        'dependsOn 只能引用此前 Task 的 key；requiredTools 只能使用可用工具中的名字。',
        '严格输出 JSON，不输出 markdown：',
        '{"tasks":[{"key":"inspect","title":"检查项目结构与关键入口","dependsOn":[],"requiredTools":["rg","fs.read"]},{"key":"summarize","title":"归纳状态、风险和下一步","dependsOn":["inspect"],"requiredTools":[]}]}',
        '',
        `目标：${input.goal.statement}`,
        `当前权限：${input.goal.permissionCeiling}`,
        `可用工具：${tools || '（无）'}`,
        `Goal 轮次上限：${limits.maxSteps ?? DEFAULT_GOAL_MAX_STEPS}`,
        ...(limits.maxCostUsd !== undefined ? [`Goal 成本上限：$${limits.maxCostUsd}`] : []),
        'Goal 成功条件：' +
            (input.goal.contract.successConditions
                .map((condition) => condition.description ?? condition.id)
                .join('；') || '（无额外条件）'),
        ...(input.sessionContext !== undefined
            ? ['会话上下文：', input.sessionContext.slice(0, 6000)]
            : []),
    ].join('\n');
}

export function createLlmTaskPlanner(complete: (prompt: string) => Promise<string>): TaskPlanner {
    return async (input) =>
        parseTaskPlan(
            await complete(buildTaskPlannerPrompt(input)),
            input.goal,
            input.maxTasks ?? DEFAULT_MAX_PLAN_TASKS,
        );
}
