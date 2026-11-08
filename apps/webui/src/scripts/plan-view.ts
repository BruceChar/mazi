/**
 * plan-view —— 运行时 TaskPlan 的展示投影（纯函数，零 DOM，供 ExecStream.vue 与单测使用）。
 *
 * 计划数据有两条来源，展示层按「实时优先、快照兜底」合并：
 * - SSE `plan.created` / `plan.revised`（store.runPlans）：计划一生成就渲染 Goal→Task→Step
 *   树，不必等 timeline 刷新，也不受 250ms 防抖影响；payload 自带完整 Task 列表。
 * - timeline 快照（GET /api/sessions/:id/timeline，TaskNodeView 带 planVersion）：
 *   历史 run / 页面刷新后的兜底数据，同时补齐 Task 的落库 status 与 step 数。
 *
 * 计划版本映射（runtime 契约）：初始计划 = 1；第 N 次 replan → N + 1。当前计划 =
 * 版本号最大的那批 Task；历史数据没有 planVersion 时不过滤（优雅降级，仍显示全部）。
 * 被更高版本淘汰的 Task 不再进入当前计划树（审计数据仍在 Trace 面板）。
 */

/** TaskPlan 的 Task 视图（runtime 事件 / timeline 快照共有的展示字段）。 */
export interface PlanTaskLike {
    taskId: string;
    title: string;
    dependsOn?: string[];
    /** 计划版本：初始 = 1，第 N 次 replan = N + 1；旧数据缺省。 */
    planVersion?: number;
    /** 落库状态（事件 plan.revised / timeline 快照提供；plan.created 缺省）。 */
    status?: string;
    /** timeline 快照里的步骤（仅用于步数兜底）。 */
    steps?: readonly unknown[];
}

/** 当前 run 的最新计划事件归约结果（store.runPlans[rootGoalId]）。 */
export interface RunPlanLike {
    planVersion?: number;
    revision?: number;
    tasks?: readonly PlanTaskLike[];
}

/** store 里按 rootGoalId 归约出的最新计划（plan.created / plan.revised）。 */
export interface RunPlan extends RunPlanLike {
    planVersion: number;
    revision: number;
    tasks: PlanTaskLike[];
    updatedAt: number;
}

/** GoalTreeSnapshot 的最小形状（只关心 goals[].tasks）。 */
export interface SnapshotLike {
    goals?: readonly { tasks?: readonly PlanTaskLike[] }[] | null;
}

/** 实时步骤的最小形状（store.LiveStep 的结构子集）。 */
export interface PlanStepLike {
    taskId?: string;
    status?: string;
}

/** Task 状态徽标色调（与 ExecStream 的 .exec-task-status tone class 对应）。 */
export type PlanTaskTone = 'pending' | 'running' | 'ok' | 'fail' | 'aborted' | 'skipped' | '';

/** Task 在当前计划树里的一行。 */
export interface PlanTaskRow {
    taskId: string;
    title: string;
    /** 原始 status（未知时为 pending）。 */
    status: string;
    statusLabel: string;
    tone: PlanTaskTone;
    /** 已执行/已落库的 step 数（取实时与快照的较大值，避免刷新防抖导致回退）。 */
    stepCount: number;
}

/** 当前计划的展示投影。 */
export interface PlanView {
    /** 当前计划版本；无版本信息（历史数据）时为 null。 */
    planVersion: number | null;
    /** 计划修订次数（版本 - 1；<=1 时为 0）。 */
    revisions: number;
    /** 当前计划的 Task 行（保持计划顺序）。 */
    tasks: PlanTaskRow[];
    /** 不在当前计划里的旧计划 Task 数（被过滤，审计仍可在 Trace 查看）。 */
    supersededCount: number;
}

/** 一条实时步骤的展示条目（ExecStream 的 livePlaced.steps 元素）。 */
export interface LiveStepEntryLike {
    step: { taskId?: string; stepId?: string };
}

/** 当前计划里的一个 Task 及其实时步骤；task=null 表示计划未知时的扁平回退组。 */
export interface LiveTaskGroup<T extends LiveStepEntryLike> {
    task: PlanTaskRow | null;
    entries: T[];
}

/** 实时步骤按当前计划分组的投影。 */
export interface LiveStepGroups<T extends LiveStepEntryLike> {
    groups: LiveTaskGroup<T>[];
    /** 不属于当前计划 Task 的步骤（被替换的旧计划尝试）；只在分组里计数，不渲染。 */
    unassigned: T[];
}

/** 状态文案（Task 行徽标）：待执行 / 执行中 / 成功 / 失败 / 已中止 / 跳过。 */
export const PLAN_TASK_STATUS_LABEL: Record<string, string> = {
    pending: '待执行',
    active: '执行中',
    running: '执行中',
    succeeded: '成功',
    completed: '成功',
    failed: '失败',
    error: '失败',
    blocked: '失败',
    aborted: '已中止',
    timeout: '已中止',
    skipped: '跳过',
};

const PLAN_TASK_STATUS_TONE: Record<string, PlanTaskTone> = {
    pending: 'pending',
    active: 'running',
    running: 'running',
    succeeded: 'ok',
    completed: 'ok',
    failed: 'fail',
    error: 'fail',
    blocked: 'fail',
    aborted: 'aborted',
    timeout: 'aborted',
    skipped: 'skipped',
};

export function planTaskStatusLabel(status: string | null | undefined): string {
    if (!status) return PLAN_TASK_STATUS_LABEL.pending;
    return PLAN_TASK_STATUS_LABEL[status] ?? status;
}

export function planTaskStatusTone(status: string | null | undefined): PlanTaskTone {
    if (!status) return 'pending';
    return PLAN_TASK_STATUS_TONE[status] ?? '';
}

/** `计划 v2`；无版本信息时为空串（历史数据不显示版本 chip）。 */
export function planVersionLabel(planVersion: number | null | undefined): string {
    const version = finiteVersion(planVersion);
    return version === null ? '' : `计划 v${version}`;
}

/** `已修订 N 次`；未修订时为空串（调用方按需 v-if）。 */
export function planRevisionLabel(revisions: number | null | undefined): string {
    const count = finiteVersion(revisions);
    return count !== null && count > 0 ? `已修订 ${count} 次` : '';
}

function finiteVersion(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asTasks(tasks: readonly PlanTaskLike[] | null | undefined): PlanTaskLike[] {
    return Array.isArray(tasks) ? tasks.filter((task) => Boolean(task?.taskId)) : [];
}

/** 一批 Task 的最高计划版本；没有任何版本信息（历史数据）时返回 null。 */
export function planVersionOf(tasks: readonly PlanTaskLike[] | null | undefined): number | null {
    let max: number | null = null;
    for (const task of asTasks(tasks)) {
        const version = finiteVersion(task.planVersion);
        if (version !== null && (max === null || version > max)) max = version;
    }
    return max;
}

/**
 * 当前计划的 Task：只保留最高 planVersion 的那批（runtime 每次 replan 会把整棵
 * 当前计划重新落库为新版本）；没有任何版本信息时原样返回（旧数据优雅降级）。
 */
export function latestPlanTasks(tasks: readonly PlanTaskLike[] | null | undefined): PlanTaskLike[] {
    const list = asTasks(tasks);
    const version = planVersionOf(list);
    if (version === null) return list;
    return list.filter((task) => finiteVersion(task.planVersion) === version);
}

/** 计划修订次数：版本 - 1（版本 1 / 无版本 = 0）。 */
export function planRevisions(planVersion: number | null | undefined): number {
    const version = finiteVersion(planVersion);
    return version === null ? 0 : Math.max(0, Math.floor(version) - 1);
}

function snapshotTasksOf(snapshot: SnapshotLike | null | undefined): PlanTaskLike[] {
    const goals = Array.isArray(snapshot?.goals) ? snapshot.goals : [];
    return goals.flatMap((goal) => asTasks(goal?.tasks));
}

/**
 * 当前计划的展示投影（live 与 settled 共用）：
 * - plan（plan.created / plan.revised）里有 Task 时以其为权威当前计划（事件自带完整列表，
 *   不必等快照刷新）；否则回退到快照里按最高 planVersion 过滤后的 Task。
 * - Task 状态优先取事件/快照的落库 status；两者都缺时按实时步骤推断（有步骤 = 执行中，否则待执行）。
 * - supersededCount = 快照里不在当前计划中的旧计划 Task 数（旧计划尝试，Trace 可查）。
 */
export function planViewOf(input: {
    plan?: RunPlanLike | null;
    snapshot?: SnapshotLike | null;
    liveSteps?: readonly PlanStepLike[] | null;
}): PlanView {
    const snapshotTasks = snapshotTasksOf(input.snapshot);
    const eventTasks = asTasks(input.plan?.tasks);
    const planTasks = eventTasks.length > 0 ? eventTasks : latestPlanTasks(snapshotTasks);
    const planVersion =
        finiteVersion(input.plan?.planVersion) ??
        planVersionOf(planTasks) ??
        planVersionOf(snapshotTasks);

    const snapshotByTask = new Map<string, PlanTaskLike>();
    for (const task of snapshotTasks) {
        if (!snapshotByTask.has(task.taskId)) snapshotByTask.set(task.taskId, task);
    }
    const liveByTask = new Map<string, { count: number; active: boolean }>();
    for (const step of input.liveSteps ?? []) {
        const taskId = String(step?.taskId ?? '');
        if (!taskId) continue;
        const entry = liveByTask.get(taskId) ?? { count: 0, active: false };
        entry.count += 1;
        // pending/active 都表示该 Task 已被调度 → 执行中；快照刷新后以落库 status 为准。
        if (step.status === 'active' || step.status === 'pending') entry.active = true;
        liveByTask.set(taskId, entry);
    }

    const seen = new Set<string>();
    const tasks: PlanTaskRow[] = [];
    for (const task of planTasks) {
        if (seen.has(task.taskId)) continue;
        seen.add(task.taskId);
        const snapshotTask = snapshotByTask.get(task.taskId);
        const live = liveByTask.get(task.taskId);
        const status =
            task.status || snapshotTask?.status || (live !== undefined ? 'active' : 'pending');
        tasks.push({
            taskId: task.taskId,
            title: task.title || snapshotTask?.title || task.taskId,
            status,
            statusLabel: planTaskStatusLabel(status),
            tone: planTaskStatusTone(status),
            stepCount: Math.max(live?.count ?? 0, snapshotTask?.steps?.length ?? 0),
        });
    }

    const supersededCount =
        planVersion === null ? 0 : snapshotTasks.filter((task) => !seen.has(task.taskId)).length;

    return {
        planVersion,
        revisions: planRevisions(planVersion),
        tasks,
        supersededCount,
    };
}

/**
 * 实时步骤按当前计划 Task 分组（保持计划顺序与步骤到达顺序）：
 * - 计划未知（tasks 为空）→ 单个 task=null 的扁平回退组，保持旧行为；
 * - 属于当前计划的步骤 → 落到对应 Task 组；不属于当前计划的步骤（旧计划尝试）→ unassigned，
 *   只用于显示一条「已替换的计划尝试」提示，不进入当前计划树。
 */
export function groupLiveStepsByTask<T extends LiveStepEntryLike>(
    entries: readonly T[] | null | undefined,
    tasks: readonly PlanTaskRow[] | null | undefined,
): LiveStepGroups<T> {
    const list = Array.isArray(entries) ? [...entries] : [];
    const planTasks = Array.isArray(tasks) ? tasks : [];
    if (planTasks.length === 0) {
        return { groups: [{ task: null, entries: list }], unassigned: [] };
    }
    const known = new Set(planTasks.map((task) => task.taskId));
    const byTask = new Map<string, T[]>();
    const unassigned: T[] = [];
    for (const entry of list) {
        const taskId = String(entry?.step?.taskId ?? '');
        if (taskId && known.has(taskId)) {
            const bucket = byTask.get(taskId);
            if (bucket) bucket.push(entry);
            else byTask.set(taskId, [entry]);
        } else {
            unassigned.push(entry);
        }
    }
    const groups = planTasks.map((task) => ({
        task,
        entries: byTask.get(task.taskId) ?? [],
    }));
    return { groups, unassigned };
}

/**
 * 「已替换的计划尝试」数量：被过滤的旧计划 Task 数与无归属实时步骤的去重 Task 数取大
 * （快照刷新前旧 Task 可能已从快照消失，只能从实时步骤推断）。
 */
export function supersededAttemptCount(
    view: PlanView,
    unassignedSteps: readonly LiveStepEntryLike[],
): number {
    const taskIds = new Set<string>();
    for (const entry of unassignedSteps) {
        const taskId = String(entry?.step?.taskId ?? '');
        if (taskId) taskIds.add(taskId);
    }
    return Math.max(view.supersededCount, taskIds.size);
}
