/**
 * audit —— 观测看板的纯计算层（docs/web/观测看板设计.md）。
 * 只做「快照/实时步骤 → 面板视图」的投影：聚合 token/cost/timing、计算 context 分段占比与逐步骤 diff。
 * 无副作用，不依赖 Vue，便于单测。
 */

import type { GoalTreeSnapshot, StepRuntimeUsage, StepUsage } from '../types.ts';

// ============================================================
// Types
// ============================================================

/** 执行中的实时步骤（store.LiveStep 的审计子集）。 */
export interface AuditLiveStep {
    stepId: string;
    taskId: string;
    kind: string;
    toolName: string;
    content: string;
    status: string;
    startedAt: number;
    endedAt: number | null;
    usage?: StepUsage | null;
}

/** Context 装填的一段（stacked bar / 图例）。 */
export interface AuditSegment {
    key: string;
    label: string;
    tokens: number;
    ratio: number;
    colorVar: string;
}

/** 聚合后的用量事实（Task/Run 为多步之和；runtime 取最新一轮）。 */
export interface AggregatedUsage {
    vendor: {
        input: number;
        output: number;
        cacheRead: number;
        cacheCreation: number;
        reasoning: number;
        total: number;
    } | null;
    runtime: StepRuntimeUsage | null;
    cost: {
        total: number;
        input: number;
        output: number;
        cacheWrite: number;
        cacheRead: number;
        reasoning: number;
        tier: string;
    } | null;
    timing: { ttftMs: number; totalMs: number; tokensPerSecond: number } | null;
}

/** 步骤明细行（Task/Run 级逐步骤 context diff）。 */
export interface AuditStepRow {
    stepId: string;
    index: number;
    kind: string;
    toolName: string;
    status: string;
    durationMs: number | null;
    tokens: number;
    contextTotal: number | null;
    contextDelta: number | null;
    selected: boolean;
}

/** Step 级 context diff。 */
export interface AuditDiff {
    delta: number;
    from: number;
    to: number;
}

/** 面板视图。 */
export interface AuditView {
    kind: 'step' | 'task' | 'run' | 'none';
    stale: boolean;
    title: string;
    subtitle: string;
    usage: AggregatedUsage;
    segments: AuditSegment[];
    utilization: number | null;
    diff: AuditDiff | null;
    strategies: string[];
    budgetPressureAction: string;
    rows: AuditStepRow[];
    /** 选中 Step 的正文预览（step 目标才有）。 */
    text: string;
}

export interface AuditInput {
    snapshot: GoalTreeSnapshot | null;
    liveSteps?: AuditLiveStep[];
    stepId?: string;
    taskId?: string;
    runInput?: string;
}

interface ResolvedStep {
    stepId: string;
    taskId: string;
    goalId: string;
    taskIndex: number;
    taskTitle: string;
    index: number;
    kind: string;
    toolName: string;
    status: string;
    startedAt: number;
    endedAt: number | null;
    durationMs: number | null;
    usage: StepUsage | null;
    text: string;
}

// ============================================================
// Aggregation
// ============================================================

interface UsageBearingStep {
    startedAt: number;
    usage?: StepUsage | null;
}

/** 多步用量聚合：vendor/cost 求和，runtime 取时间最新，timing 求和 + TTFT 平均。 */
export function aggregateUsage(steps: UsageBearingStep[]): AggregatedUsage {
    let vendor: AggregatedUsage['vendor'] = null;
    let cost: AggregatedUsage['cost'] = null;
    let runtime: StepRuntimeUsage | null = null;
    let runtimeAt = Number.NEGATIVE_INFINITY;
    let totalMs = 0;
    let ttftSum = 0;
    let ttftCount = 0;
    let outputTokens = 0;
    let hasTiming = false;
    for (const step of steps) {
        const usage = step.usage;
        if (!usage) continue;
        if (usage.vendor) {
            if (!vendor) {
                vendor = {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheCreation: 0,
                    reasoning: 0,
                    total: 0,
                };
            }
            const input = usage.vendor.inputTokens ?? 0;
            const output = usage.vendor.outputTokens ?? 0;
            vendor.input += input;
            vendor.output += output;
            vendor.cacheRead += usage.vendor.cacheReadInputTokens ?? 0;
            vendor.cacheCreation += usage.vendor.cacheCreationInputTokens ?? 0;
            vendor.reasoning += usage.vendor.reasoningOutputTokens ?? 0;
            vendor.total += input + output;
        }
        if (usage.cost) {
            if (!cost) {
                cost = {
                    total: 0,
                    input: 0,
                    output: 0,
                    cacheWrite: 0,
                    cacheRead: 0,
                    reasoning: 0,
                    tier: '',
                };
            }
            cost.total += usage.cost.totalCostUsd ?? 0;
            cost.input += usage.cost.inputCostUsd ?? 0;
            cost.output += usage.cost.outputCostUsd ?? 0;
            cost.cacheWrite += usage.cost.cacheWriteCostUsd ?? 0;
            cost.cacheRead += usage.cost.cacheReadCostUsd ?? 0;
            cost.reasoning += usage.cost.reasoningCostUsd ?? 0;
            if (usage.cost.priceTierApplied) cost.tier = usage.cost.priceTierApplied;
        }
        if (usage.runtime && step.startedAt >= runtimeAt) {
            runtime = usage.runtime;
            runtimeAt = step.startedAt;
        }
        if (usage.timing) {
            hasTiming = true;
            totalMs += usage.timing.totalMs ?? 0;
            ttftSum += usage.timing.ttftMs ?? 0;
            ttftCount += 1;
            outputTokens += usage.vendor?.outputTokens ?? 0;
        }
    }
    const timing = hasTiming
        ? {
              ttftMs: ttftCount > 0 ? ttftSum / ttftCount : 0,
              totalMs,
              tokensPerSecond:
                  outputTokens > 0 && totalMs - ttftSum > 0
                      ? (outputTokens / (totalMs - ttftSum)) * 1000
                      : 0,
          }
        : null;
    return { vendor, runtime, cost, timing };
}

// ============================================================
// Context segments
// ============================================================

const OPTIONAL_SEGMENTS = new Set(['retrieved', 'example']);

interface SegmentDef {
    key: string;
    label: string;
    colorVar: string;
    pick: (runtime: StepRuntimeUsage) => number;
}

const SEGMENT_DEFS: SegmentDef[] = [
    {
        key: 'system',
        label: 'system prompt',
        colorVar: '--thinking',
        pick: (r) => r.systemPromptTokens ?? 0,
    },
    { key: 'history', label: 'history', colorVar: '--tool', pick: (r) => r.historyTokens ?? 0 },
    {
        key: 'toolSchema',
        label: 'tool schema',
        colorVar: '--warn',
        pick: (r) => r.toolSchemaTokens ?? 0,
    },
    {
        key: 'newInput',
        label: 'user input',
        colorVar: '--accent',
        pick: (r) => r.newInputTokens ?? 0,
    },
    {
        key: 'observation',
        label: 'observation',
        colorVar: '--ok',
        pick: (r) => r.observationTokens ?? 0,
    },
    {
        key: 'retrieved',
        label: 'retrieved',
        colorVar: '--fg-tertiary',
        pick: (r) => r.retrievedTokens ?? 0,
    },
    {
        key: 'example',
        label: 'examples',
        colorVar: '--fg-tertiary',
        pick: (r) => r.exampleTokens ?? 0,
    },
];

/** Runtime 分段 → 占比段（分母 totalContextTokens，缺省回落到分段和；可选段为 0 时省略）。 */
export function contextSegments(runtime: StepRuntimeUsage | null | undefined): AuditSegment[] {
    if (!runtime) return [];
    const sum = SEGMENT_DEFS.reduce((total, def) => total + def.pick(runtime), 0);
    const denominator =
        (runtime.totalContextTokens ?? 0) > 0 ? (runtime.totalContextTokens ?? 0) : sum;
    return SEGMENT_DEFS.filter(
        (def) => !OPTIONAL_SEGMENTS.has(def.key) || def.pick(runtime) > 0,
    ).map((def) => {
        const tokens = def.pick(runtime);
        return {
            key: def.key,
            label: def.label,
            tokens,
            ratio: denominator > 0 ? tokens / denominator : 0,
            colorVar: def.colorVar,
        };
    });
}

// ============================================================
// View building
// ============================================================

function taskIndexMap(
    snapshot: GoalTreeSnapshot | null,
): Map<string, { index: number; title: string }> {
    const map = new Map<string, { index: number; title: string }>();
    if (!snapshot) return map;
    let index = 0;
    for (const goal of snapshot.goals ?? []) {
        for (const task of goal.tasks ?? []) {
            index += 1;
            map.set(task.taskId, { index, title: task.title });
        }
    }
    return map;
}

function collectSnapshotSteps(snapshot: GoalTreeSnapshot | null): ResolvedStep[] {
    if (!snapshot) return [];
    const out: ResolvedStep[] = [];
    let taskIndex = 0;
    for (const goal of snapshot.goals ?? []) {
        for (const task of goal.tasks ?? []) {
            taskIndex += 1;
            const steps = (task.steps ?? []).slice().sort((a, b) => a.startedAt - b.startedAt);
            steps.forEach((step, i) => {
                out.push({
                    stepId: step.stepId,
                    taskId: task.taskId,
                    goalId: goal.goalId,
                    taskIndex,
                    taskTitle: task.title,
                    index: i + 1,
                    kind: step.kind,
                    toolName: step.toolName ?? '',
                    status: step.status,
                    startedAt: step.startedAt ?? 0,
                    endedAt: step.endedAt ?? null,
                    durationMs:
                        step.endedAt && step.startedAt ? step.endedAt - step.startedAt : null,
                    usage: step.usage ?? null,
                    text: step.content ?? step.payloadText ?? '',
                });
            });
        }
    }
    return out;
}

function collectRows(input: AuditInput): ResolvedStep[] {
    const snapshotRows = collectSnapshotSteps(input.snapshot);
    const known = new Set(snapshotRows.map((row) => row.stepId));
    const indexMap = taskIndexMap(input.snapshot);
    const titles = new Map<string, string>();
    if (input.snapshot) {
        for (const goal of input.snapshot.goals ?? []) {
            for (const task of goal.tasks ?? []) titles.set(task.taskId, task.title);
        }
    }
    const liveRows: ResolvedStep[] = [];
    const liveCount = new Map<string, number>();
    for (const step of input.liveSteps ?? []) {
        if (known.has(step.stepId)) continue;
        const next = (liveCount.get(step.taskId) ?? 0) + 1;
        liveCount.set(step.taskId, next);
        const meta = indexMap.get(step.taskId);
        liveRows.push({
            stepId: step.stepId,
            taskId: step.taskId,
            goalId: '',
            taskIndex: meta?.index ?? 0,
            taskTitle: titles.get(step.taskId) ?? '',
            index: next,
            kind: step.kind,
            toolName: step.toolName,
            status: step.status,
            startedAt: step.startedAt,
            endedAt: step.endedAt,
            durationMs: step.endedAt ? step.endedAt - step.startedAt : null,
            usage: step.usage ?? null,
            text: step.content,
        });
    }
    return snapshotRows.concat(liveRows);
}

function toRow(step: ResolvedStep, selectedId: string): AuditStepRow {
    const runtime = step.usage?.runtime;
    const tokens = (step.usage?.vendor?.inputTokens ?? 0) + (step.usage?.vendor?.outputTokens ?? 0);
    return {
        stepId: step.stepId,
        index: step.index,
        kind: step.kind,
        toolName: step.toolName,
        status: step.status,
        durationMs: step.durationMs,
        tokens,
        contextTotal: runtime?.totalContextTokens ?? null,
        contextDelta: runtime?.contextDeltaFromPrev ?? null,
        selected: step.stepId === selectedId,
    };
}

const EMPTY_USAGE: AggregatedUsage = { vendor: null, runtime: null, cost: null, timing: null };

/** 目标解析：step 优先于 task；两者都无 → run 汇总。 */
export function buildAuditView(input: AuditInput): AuditView {
    const rows = collectRows(input);
    const stepId = input.stepId ?? '';
    const taskId = input.taskId ?? '';
    const selected = stepId ? rows.find((row) => row.stepId === stepId) : undefined;
    const taskRows = taskId ? rows.filter((row) => row.taskId === taskId) : [];
    const taskExists = input.snapshot
        ? (input.snapshot.goals ?? []).some((goal) =>
              (goal.tasks ?? []).some((task) => task.taskId === taskId),
          )
        : false;

    if (stepId && !selected) {
        return {
            kind: 'none',
            stale: true,
            title: '目标已失效',
            subtitle: '请重新选择 Step 或 Task',
            usage: EMPTY_USAGE,
            segments: [],
            utilization: null,
            diff: null,
            strategies: [],
            budgetPressureAction: '',
            rows: [],
            text: '',
        };
    }
    if (taskId && taskRows.length === 0 && !taskExists) {
        return {
            kind: 'none',
            stale: true,
            title: '目标已失效',
            subtitle: '请重新选择 Step 或 Task',
            usage: EMPTY_USAGE,
            segments: [],
            utilization: null,
            diff: null,
            strategies: [],
            budgetPressureAction: '',
            rows: [],
            text: '',
        };
    }

    if (selected) {
        const usage = aggregateUsage([selected]);
        const runtime = usage.runtime;
        const siblings = rows.filter((row) => row.taskId === selected.taskId);
        const siblingRows = (siblings.length > 0 ? siblings : [selected]).map((row) =>
            toRow(row, stepId),
        );
        const total = runtime?.totalContextTokens ?? null;
        const delta = runtime?.contextDeltaFromPrev ?? null;
        const toolSuffix = selected.toolName ? ` ${selected.toolName}` : '';
        const statusSuffix = selected.status ? ` · ${selected.status}` : '';
        return {
            kind: 'step',
            stale: false,
            title: `S#${selected.index} · ${kindLabel(selected.kind)}${toolSuffix}`,
            subtitle: `${formatDuration(selected.durationMs)}${statusSuffix}`,
            usage,
            segments: contextSegments(runtime),
            utilization: runtime?.contextWindowUtilization ?? null,
            diff:
                total !== null && delta !== null ? { delta, from: total - delta, to: total } : null,
            strategies: runtime?.strategyApplied ?? [],
            budgetPressureAction: runtime?.budgetPressureAction ?? '',
            rows: siblingRows,
            text: selected.text,
        };
    }

    if (taskId) {
        const usage = aggregateUsage(taskRows);
        const runtime = usage.runtime;
        const title = taskRows[0]?.taskTitle || 'Task';
        const index = taskRows[0]?.taskIndex ?? 0;
        return {
            kind: 'task',
            stale: false,
            title: `T#${index} · ${title}`,
            subtitle: `${taskRows.length} steps`,
            usage,
            segments: contextSegments(runtime),
            utilization: runtime?.contextWindowUtilization ?? null,
            diff: null,
            strategies: runtime?.strategyApplied ?? [],
            budgetPressureAction: runtime?.budgetPressureAction ?? '',
            rows: taskRows.map((row) => toRow(row, stepId)),
            text: '',
        };
    }

    const usage = aggregateUsage(rows);
    const runtime = usage.runtime;
    return {
        kind: 'run',
        stale: false,
        title: 'Run 汇总',
        subtitle: (input.runInput ?? '').trim() || `${rows.length} steps`,
        usage,
        segments: contextSegments(runtime),
        utilization: runtime?.contextWindowUtilization ?? null,
        diff: null,
        strategies: runtime?.strategyApplied ?? [],
        budgetPressureAction: runtime?.budgetPressureAction ?? '',
        rows: rows.map((row) => toRow(row, stepId)),
        text: '',
    };
}

/** 空视图（未选择目标）。 */
export function emptyAuditView(): AuditView {
    return {
        kind: 'none',
        stale: false,
        title: '未选择',
        subtitle: '点击对话流中的 Step 或 Task 查看审计',
        usage: EMPTY_USAGE,
        segments: [],
        utilization: null,
        diff: null,
        strategies: [],
        budgetPressureAction: '',
        rows: [],
        text: '',
    };
}

// ============================================================
// Formatting
// ============================================================

export function kindLabel(kind: string): string {
    if (kind === 'tool_call') return 'tool';
    return kind || '-';
}

export function formatTokens(value: number | null | undefined): string {
    const n = value ?? 0;
    if (n < 1000) return String(n);
    if (n < 1_000_000) return `${trimZero(n / 1000)}K`;
    return `${trimZero(n / 1_000_000)}M`;
}

function trimZero(value: number): string {
    const fixed = value.toFixed(1);
    return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}

export function formatCost(usd: number | null | undefined): string {
    const n = Number(usd ?? 0);
    if (!Number.isFinite(n) || n === 0) return '$0';
    return `$${n.toFixed(6)}`;
}

export function formatPercent(ratio: number | null | undefined): string {
    return `${((ratio ?? 0) * 100).toFixed(1)}%`;
}

export function formatDuration(ms: number | null | undefined): string {
    if (ms === null || ms === undefined) return '';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

export function formatDrift(drift: number | null | undefined): string {
    if (drift === null || drift === undefined) return '';
    return (drift >= 0 ? '+' : '') + String(drift);
}
