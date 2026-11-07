import type { Goal } from '@mazi/core';
import {
    DEFAULT_GOAL_MAX_STEPS,
    effectiveGoalLimits,
    type PlannedTask,
    type PlanTool,
} from './plan-graph.js';

export const DEFAULT_MAX_PLAN_TASKS = 6;

/** Per-turn clip for the recent-conversation block fed to the planner. */
export const TASK_PLANNER_HISTORY_ENTRY_MAX_CHARS = 1500;

/** Total clip for the recent-conversation block fed to the planner. */
export const TASK_PLANNER_HISTORY_MAX_CHARS = 4000;

export interface TaskPlannerHistoryEntry {
    role: 'user' | 'assistant';
    text: string;
}

export interface TaskPlanningInput {
    goal: Goal;
    availableTools: readonly PlanTool[];
    sessionContext?: string;
    /**
     * Recent conversation, oldest first.
     *
     * The planner only sees a bounded tail: each turn is clipped and the oldest
     * turns are dropped once the total budget is spent, so the newest context
     * (which usually carries the real goal) always survives.
     */
    history?: ReadonlyArray<TaskPlannerHistoryEntry>;
    /**
     * Retry hint after a collapsed plan: the goal carries multiple independent
     * artifacts/acceptance conditions, so a single generic Task is not acceptable.
     */
    strictSplit?: boolean;
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

const RECENT_HISTORY_HEADER =
    '最近对话（按时间正序，最后一条最新；越近越相关。用户当前输入可能只是对上述方案的简写选择，' +
    '必须结合对话历史还原完整目标）：';

function clipHistoryText(text: string, maxChars: number): string {
    const normalized = text.trim().replace(/\s+/g, ' ');
    if (normalized.length <= maxChars) return normalized;
    return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** Format the bounded recent-conversation tail; returns undefined when nothing usable remains. */
function buildRecentHistorySection(
    history: ReadonlyArray<TaskPlannerHistoryEntry>,
): string[] | undefined {
    const lines: string[] = [];
    let used = 0;
    for (let index = history.length - 1; index >= 0; index -= 1) {
        const entry = history[index];
        const text = clipHistoryText(entry.text, TASK_PLANNER_HISTORY_ENTRY_MAX_CHARS);
        if (text.length === 0) continue;
        const line = `- ${entry.role}: ${text}`;
        // Keep the newest turn unconditionally; older turns must fit the total budget.
        if (lines.length > 0 && used + line.length > TASK_PLANNER_HISTORY_MAX_CHARS) break;
        lines.push(line);
        used += line.length;
    }
    if (lines.length === 0) return undefined;
    return [RECENT_HISTORY_HEADER, ...lines.reverse()];
}

export function buildTaskPlannerPrompt(input: TaskPlanningInput): string {
    const maxTasks = input.maxTasks ?? DEFAULT_MAX_PLAN_TASKS;
    const limits = effectiveGoalLimits(input.goal);
    const tools = input.availableTools
        .map((tool) => `${tool.name}(${tool.minPermission})`)
        .join(', ');
    const historySection = buildRecentHistorySection(input.history ?? []);
    return [
        '你是 Task Planner。把用户目标拆成可独立执行、可验收的 Task DAG。',
        `Task 数量 1-${maxTasks}。只有简单目标才允许 1 个 Task；不要为了形式拆步骤，也不要为了省事跳过拆分。`,
        '目标包含多个独立产物或清晰阶段时，必须拆成多个 Task，并用 dependsOn 表达先后顺序。',
        '例如：修复编译错误、提交基线 commit、新建模块、注册模块、写测试并跑测试、更新文档，',
        '往往是多个 Task 而不是一个，应按阶段和产物拆分。',
        '禁止把执行类目标（要改代码、要写文件、要提交、要安装依赖、要跑测试）塌缩成单个',
        '「检查/分析并给出最终回答」类 Task；这类 Task 会让执行器停在分析阶段，只用口头总结收尾。',
        '每个 Task 必须是一个完整工作单元，title 简短、动作导向，且能在当前 Task 内独立验收。',
        '不要把每个工具调用拆成 Task，但也不要把多个产物合并进同一个 Task 来逃避拆分。',
        '执行器每次只完成当前 Task；依赖 Task 的产物会通过前置结果提供，不要提前完成后续阶段。',
        ...(input.strictSplit === true
            ? [
                  '本次目标包含多个独立产物/验收条件：必须拆成至少 2 个 Task；',
                  '返回单个 Task 视为无效计划。',
              ]
            : []),
        'dependsOn 只能引用此前 Task 的 key；requiredTools 只能使用可用工具中的名字。',
        '严格输出 JSON，不输出 markdown：',
        '{"tasks":[{"key":"fix-build","title":"修复编译错误并通过构建","dependsOn":[],"requiredTools":["fs.read","fs.write","shell.run"]},{"key":"add-module","title":"新建并注册模块","dependsOn":["fix-build"],"requiredTools":["fs.write"]}]}',
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
        ...(historySection !== undefined ? historySection : []),
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
