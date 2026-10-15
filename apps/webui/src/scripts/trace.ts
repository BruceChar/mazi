/**
 * trace —— Trace 看板（「审计」+「Context」合并）的纯计算层（docs/web/观测看板设计.md v3）。
 * 只做「会话步骤行 → 看板视图」投影：KPI 概览、按 Task 分组的 span 树、
 * 时间线 / Context 两种视图的条几何、过滤器。无副作用，不依赖 Vue，便于单测。
 */

import type { AuditDiffPart, AuditStepRow, AuditTaskRow } from './audit.ts';
import { kindLabel } from './audit.ts';

/** span 在两种视图中的最小可见条宽（%）：极短 span 也要能点到。 */
export const TRACE_MIN_BAR_PERCENT = 2;

/** trace 列表过滤器：全部 / 只看模型步 / 只看工具调用 / 只看异常。 */
export type TraceFilter = 'all' | 'model' | 'tool' | 'error';

/** trace 列表视图：时间瀑布 / Context 增长条。 */
export type TraceViewMode = 'timeline' | 'context';

/** 会话级聚合用量（AggregatedUsage 的结构子集，只取 KPI 需要的字段）。 */
export interface TraceUsageInput {
    vendor?: { input?: number; output?: number; cacheRead?: number } | null;
    cost?: { total?: number } | null;
}

/** 条几何（%，相对视图基准）。 */
export interface TraceBar {
    left: number;
    width: number;
}

/** Context 堆叠条的一段。 */
export interface TraceSpanSegment {
    key: string;
    label: string;
    colorVar: string;
    tokens: number;
    width: number;
}

/** 一个 span：模型步可带工具子 span（ReAct 调用 → 结果）。 */
export interface TraceSpan {
    stepId: string;
    taskId: string;
    /** `R#n·T#n·S#n` 整体编号 */
    loc: string;
    kind: string;
    /** 语义类型标签（model / tool / 原样） */
    kindLabel: string;
    /** 展示名：工具名优先，否则 kind */
    name: string;
    status: string;
    isTool: boolean;
    isError: boolean;
    startedAt: number;
    endedAt: number | null;
    durationMs: number | null;
    tokens: number;
    tokensPerSecond: number | null;
    contextTotal: number | null;
    contextDelta: number | null;
    /** 时间线视图的条：按整条 trace 的时间跨度归一 */
    timeline: TraceBar;
    /** Context 视图的条：按会话峰值 context 归一 */
    context: Pick<TraceBar, 'width'>;
    segments: TraceSpanSegment[];
    selected: boolean;
    toolLine: string;
    toolCommand: string;
    toolOutput: string;
    toolCwd: string;
    diffParts: AuditDiffPart[];
    /** 该模型步产生的工具调用（工具 span 恒为空） */
    children: TraceSpan[];
}

/** 一个 Task（run 内）分组的 span 列表。 */
export interface TraceGroup {
    /** `runIndex:taskId` */
    key: string;
    runIndex: number;
    taskIndex: number;
    title: string;
    status: string;
    stepCount: number;
    startedAt: number | null;
    endedAt: number | null;
    durationMs: number | null;
    /** 组内 span（模型步可带 children；领先于模型步的工具调用为顶层工具 span） */
    spans: TraceSpan[];
}

/** 一个 Run（Session）分组的 Task 列表（trace 列表第一级，可折叠）。 */
export interface TraceRunGroup {
    /** `run:${runIndex}` */
    key: string;
    runIndex: number;
    /** 该 run 的用户输入摘要（缺省为空串） */
    title: string;
    stepCount: number;
    startedAt: number | null;
    endedAt: number | null;
    durationMs: number | null;
    tasks: TraceGroup[];
}

/** Run 头数据源（会话内按 run 顺序的输入）。 */
export interface TraceRunInput {
    runIndex: number;
    input?: string;
}

/** trace 级 KPI 概览。 */
export interface TraceSummary {
    steps: number;
    modelSteps: number;
    toolSteps: number;
    errorSteps: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    /** cacheRead / input；input 为 0 时 null */
    cacheHitRate: number | null;
    costUsd: number;
    startedAt: number | null;
    endedAt: number | null;
    durationMs: number | null;
}

export interface TraceLegendItem {
    key: string;
    label: string;
    colorVar: string;
}

export interface TraceBoard {
    summary: TraceSummary;
    /** Run 分组（第一级），每个 Run 内是 Task 分组（第二级） */
    runs: TraceRunGroup[];
    legend: TraceLegendItem[];
    peakContext: number;
    latestContext: number;
}

export interface TraceBoardInput {
    /** 会话流全部步骤行（conversationAudit.rows），按会话流顺序。 */
    rows: AuditStepRow[];
    /** 会话级聚合用量，用于 KPI 的 vendor / cost。 */
    usage?: TraceUsageInput | null;
    /** 会话级任务清单（conversationAudit.tasks），用于 Task 分组标题。 */
    tasks?: AuditTaskRow[];
    /** 会话内按顺序的 run 输入，用于 Run 分组标题。 */
    runs?: TraceRunInput[];
    /** 未结束 span 的截断基准（缺省 Date.now()；测试可注入）。 */
    now?: number;
}

interface SpanGeometry {
    now: number;
    traceStart: number;
    spanMs: number;
    peakContext: number;
}

/** 会话步骤行 → Trace 看板视图。 */
export function buildTraceBoard(input: TraceBoardInput): TraceBoard {
    const rows = input.rows ?? [];
    const now = input.now ?? Date.now();
    const traceStart = rows.length > 0 ? Math.min(...rows.map((row) => row.startedAt)) : 0;
    const traceEnd =
        rows.length > 0 ? Math.max(...rows.map((row) => spanEnd(row, now))) : traceStart;
    const geometry: SpanGeometry = {
        now,
        traceStart,
        spanMs: Math.max(traceEnd - traceStart, 1),
        peakContext: rows.reduce((max, row) => Math.max(max, row.contextTotal ?? 0), 0),
    };
    const titleByTask = new Map((input.tasks ?? []).map((task) => [task.taskId, task.title]));
    const titleByRun = new Map((input.runs ?? []).map((run) => [run.runIndex, run.input ?? '']));
    return {
        summary: summarize(rows, input.usage ?? null),
        runs: groupRuns(rows, geometry, titleByTask, titleByRun),
        legend: collectLegend(rows),
        peakContext: geometry.peakContext,
        latestContext: latestContextOf(rows),
    };
}

/**
 * 过滤器：模型步保留其命中的工具子步；工具子步命中时保留父模型步作为容器；
 * 过滤后无 span 的分组移除。`all` 原样返回（不复制）。
 */
export function filterTraceGroups(groups: TraceGroup[], filter: TraceFilter): TraceGroup[] {
    if (filter === 'all') return groups;
    const out: TraceGroup[] = [];
    for (const group of groups) {
        const spans: TraceSpan[] = [];
        for (const span of group.spans) {
            if (span.isTool) {
                if (matchesFilter(span, filter)) spans.push({ ...span, children: [] });
                continue;
            }
            const children = span.children.filter((child) => matchesFilter(child, filter));
            if (children.length > 0) {
                spans.push({ ...span, children });
            } else if (filter !== 'tool' && matchesFilter(span, filter)) {
                spans.push({ ...span, children: [] });
            }
        }
        if (spans.length > 0) out.push({ ...group, spans });
    }
    return out;
}

/** Run 级过滤：对每个 Run 内的 Task 应用 span 过滤，整段没有命中的 Run 移除。 */
export function filterTraceRuns(runs: TraceRunGroup[], filter: TraceFilter): TraceRunGroup[] {
    if (filter === 'all') return runs;
    const out: TraceRunGroup[] = [];
    for (const run of runs) {
        const tasks = filterTraceGroups(run.tasks, filter);
        if (tasks.length > 0) out.push({ ...run, tasks });
    }
    return out;
}

function matchesFilter(span: TraceSpan, filter: TraceFilter): boolean {
    if (filter === 'model') return !span.isTool;
    if (filter === 'tool') return span.isTool;
    return span.isError;
}

/** 会话流顺序（Run → Task → span）投影为两级分组；工具 span 挂到同 Task 内前一个模型步之下。 */
function groupRuns(
    rows: AuditStepRow[],
    geometry: SpanGeometry,
    titleByTask: Map<string, string>,
    titleByRun: Map<number, string>,
): TraceRunGroup[] {
    const runs: TraceRunGroup[] = [];
    const runByIndex = new Map<number, TraceRunGroup>();
    const taskByKey = new Map<string, TraceGroup>();
    const lastModelByTask = new Map<string, TraceSpan | null>();
    for (const row of rows) {
        let run = runByIndex.get(row.runIndex);
        if (run === undefined) {
            run = {
                key: `run:${row.runIndex}`,
                runIndex: row.runIndex,
                title: titleByRun.get(row.runIndex) ?? '',
                stepCount: 0,
                startedAt: null,
                endedAt: null,
                durationMs: null,
                tasks: [],
            };
            runByIndex.set(row.runIndex, run);
            runs.push(run);
        }
        const taskKey = `${row.runIndex}:${row.taskId}`;
        let task = taskByKey.get(taskKey);
        if (task === undefined) {
            task = {
                key: taskKey,
                runIndex: row.runIndex,
                taskIndex: row.taskIndex,
                title: titleByTask.get(row.taskId) ?? '',
                status: row.taskStatus,
                stepCount: 0,
                startedAt: null,
                endedAt: null,
                durationMs: null,
                spans: [],
            };
            taskByKey.set(taskKey, task);
            lastModelByTask.set(taskKey, null);
            run.tasks.push(task);
        }
        const span = toSpan(row, geometry);
        task.stepCount += 1;
        run.stepCount += 1;
        extendSpan(task, row, geometry.now);
        extendSpan(run, row, geometry.now);
        const lastModel = lastModelByTask.get(taskKey) ?? null;
        if (span.isTool && lastModel !== null) {
            lastModel.children.push(span);
        } else {
            task.spans.push(span);
            if (!span.isTool) lastModelByTask.set(taskKey, span);
        }
    }
    return runs;
}

/** 分组（Run / Task）的起止与耗时聚合。 */
function extendSpan(
    target: Pick<TraceGroup, 'startedAt' | 'endedAt' | 'durationMs'>,
    row: AuditStepRow,
    now: number,
): void {
    const start =
        target.startedAt === null ? row.startedAt : Math.min(target.startedAt, row.startedAt);
    const end = spanEnd(row, now);
    const ended = target.endedAt === null ? end : Math.max(target.endedAt, end);
    target.startedAt = start;
    target.endedAt = ended;
    target.durationMs = Math.max(0, ended - start);
}

function toSpan(row: AuditStepRow, geometry: SpanGeometry): TraceSpan {
    const isTool = row.kind === 'invocation';
    const end = spanEnd(row, geometry.now);
    const rawWidth = ((end - row.startedAt) / geometry.spanMs) * 100;
    const width = round2(Math.min(100, Math.max(TRACE_MIN_BAR_PERCENT, rawWidth)));
    const rawLeft = ((row.startedAt - geometry.traceStart) / geometry.spanMs) * 100;
    const left = round2(Math.max(0, Math.min(rawLeft, 100 - width)));
    return {
        stepId: row.stepId,
        taskId: row.taskId,
        loc: `R#${row.runIndex}·T#${row.taskIndex}·S#${row.index}`,
        kind: row.kind,
        kindLabel: kindLabel(row.kind),
        name: row.toolName || row.kind,
        status: row.status,
        isTool,
        isError: isErrorStatus(row.status),
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        durationMs: row.durationMs,
        tokens: row.tokens,
        tokensPerSecond: row.tokensPerSecond,
        contextTotal: row.contextTotal,
        contextDelta: row.contextDelta,
        timeline: { left, width },
        context: { width: isTool ? 0 : contextWidthOf(row, geometry.peakContext) },
        segments: isTool ? [] : segmentsOf(row),
        selected: row.selected,
        toolLine: row.toolLine,
        toolCommand: row.toolCommand,
        toolOutput: row.toolOutput,
        toolCwd: row.toolCwd,
        diffParts: row.diffParts ?? [],
        children: [],
    };
}

function contextWidthOf(row: AuditStepRow, peakContext: number): number {
    if (!row.contextTotal || peakContext <= 0) return 0;
    return round2((row.contextTotal / peakContext) * 100);
}

function segmentsOf(row: AuditStepRow): TraceSpanSegment[] {
    const total = row.contextTotal ?? 0;
    return (row.segments ?? []).map((segment) => ({
        key: segment.key,
        label: segment.label,
        colorVar: segment.colorVar,
        tokens: segment.tokens,
        width: total > 0 ? round2((segment.tokens / total) * 100) : 0,
    }));
}

function collectLegend(rows: AuditStepRow[]): TraceLegendItem[] {
    const seen = new Map<string, TraceLegendItem>();
    for (const row of rows) {
        for (const segment of row.segments ?? []) {
            if (!seen.has(segment.key)) {
                seen.set(segment.key, {
                    key: segment.key,
                    label: segment.label,
                    colorVar: segment.colorVar,
                });
            }
        }
    }
    return [...seen.values()];
}

function latestContextOf(rows: AuditStepRow[]): number {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
        const total = rows[index]?.contextTotal;
        if (total != null) return total;
    }
    return 0;
}

function summarize(rows: AuditStepRow[], usage: TraceUsageInput | null): TraceSummary {
    const modelSteps = rows.filter((row) => row.kind !== 'invocation').length;
    const vendor = usage?.vendor ?? null;
    const input = numberOr(vendor?.input);
    const cacheRead = numberOr(vendor?.cacheRead);
    const startedAt = rows.length > 0 ? Math.min(...rows.map((row) => row.startedAt)) : null;
    const endedAt =
        rows.length > 0 ? Math.max(...rows.map((row) => row.endedAt ?? row.startedAt)) : null;
    return {
        steps: rows.length,
        modelSteps,
        toolSteps: rows.length - modelSteps,
        errorSteps: rows.filter((row) => isErrorStatus(row.status)).length,
        inputTokens: input,
        outputTokens: numberOr(vendor?.output),
        cacheReadTokens: cacheRead,
        cacheHitRate: input > 0 ? cacheRead / input : null,
        costUsd: numberOr(usage?.cost?.total),
        startedAt,
        endedAt,
        durationMs:
            startedAt === null || endedAt === null ? null : Math.max(0, endedAt - startedAt),
    };
}

/** span 实际结束时刻：未结束（执行中）用 now 截断。 */
function spanEnd(row: AuditStepRow, now: number): number {
    if (row.endedAt != null) return Math.max(row.endedAt, row.startedAt);
    return Math.max(now, row.startedAt);
}

function isErrorStatus(status: string): boolean {
    return status === 'failed' || status === 'error' || status === 'blocked';
}

function numberOr(value: number | null | undefined): number {
    const n = Number(value ?? 0);
    return Number.isFinite(n) ? n : 0;
}

function round2(value: number): number {
    return Math.round(value * 100) / 100;
}
