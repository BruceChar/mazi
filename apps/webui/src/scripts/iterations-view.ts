/**
 * iterations-view —— Iterations 面板的纯计算层（docs/web/迭代面板设计.md v1）。
 * 只做「TOC 聚合 + 系统迭代记录 + 系统版本 → 面板视图」投影：TOC 列表行、记录行、
 * 过滤、状态元信息与状态机动作、版本标签。无副作用，不依赖 Vue，便于单测。
 *
 * 状态机的**权威**在服务端（`@mazi/libs` 的 `canTransition`）；这里只给出 UI 动作清单
 * （文案 / 色调属展示层），其合法性由 iterations-view.test.ts 对照 libs 校验，避免漂移。
 */

import type {
    IterationRecordView,
    IterationStatus,
    SystemVersionRef,
    TocAnalysisStatus,
    TocAnalysisView,
    TocIterationView,
} from '../types.ts';

/** 面板分段：思维链 / 迭代记录 / 系统。 */
export type IterationSection = 'toc' | 'records' | 'system';

/** TOC 的聚合状态：无分析 = none。 */
export type TocRowStatus = 'none' | TocAnalysisStatus;

/** TOC 列表过滤器（状态）。 */
export type TocStatusFilter = 'all' | TocRowStatus;

/** 记录列表过滤器（状态）。 */
export type IterationStatusFilter = 'all' | IterationStatus;

/** 状态展示顺序（过滤 chips / 计数）。 */
export const ITERATION_STATUS_ORDER: readonly IterationStatus[] = [
    'proposed',
    'in_progress',
    'applied',
    'reverted',
    'rejected',
];

export const ITERATION_STATUS_LABELS: Record<IterationStatus, string> = {
    proposed: '提案',
    in_progress: '进行中',
    applied: '已应用',
    reverted: '已回滚',
    rejected: '已驳回',
};

export const TOC_STATUS_LABELS: Record<TocRowStatus, string> = {
    none: '未分析',
    pending: '排队中',
    running: '分析中',
    succeeded: '成功',
    failed: '失败',
};

/** 迭代记录可执行的动作（UI 文案 + 目标状态 + 色调）。 */
export interface IterationAction {
    action: 'start' | 'apply' | 'revert' | 'reject' | 'reopen';
    label: string;
    next: IterationStatus;
    tone: 'primary' | 'danger' | 'default';
}

const ITERATION_ACTIONS: Record<IterationStatus, readonly IterationAction[]> = {
    proposed: [
        { action: 'start', label: '开始迭代', next: 'in_progress', tone: 'primary' },
        { action: 'reject', label: '驳回', next: 'rejected', tone: 'default' },
    ],
    in_progress: [
        { action: 'apply', label: '标记已应用', next: 'applied', tone: 'primary' },
        { action: 'reject', label: '驳回', next: 'rejected', tone: 'default' },
    ],
    applied: [{ action: 'revert', label: '回滚', next: 'reverted', tone: 'danger' }],
    reverted: [{ action: 'start', label: '重新开始', next: 'in_progress', tone: 'primary' }],
    rejected: [{ action: 'reopen', label: '重新提案', next: 'proposed', tone: 'primary' }],
};

/** 当前状态允许的动作（与 docs/web/迭代面板设计.md §2.3 的状态机一致）。 */
export function iterationActions(status: IterationStatus): readonly IterationAction[] {
    return ITERATION_ACTIONS[status] ?? [];
}

/** 状态徽标色调（复用审计面板的 ok / run / warn / bad 语义）。 */
export function iterationStatusTone(status: IterationStatus): string {
    if (status === 'applied') return 'ok';
    if (status === 'in_progress') return 'run';
    if (status === 'reverted') return 'warn';
    if (status === 'rejected') return 'bad';
    return '';
}

/** TOC 下一次分析（带耗时与「已采纳」来源记录）。 */
export interface TocAnalysisRow {
    analysis: TocAnalysisView;
    durationMs: number | null;
    /** 由该分析采纳出的迭代记录（未采纳为 null）。 */
    record: IterationRecordView | null;
}

/** TOC 列表行。 */
export interface TocRow {
    tocId: string;
    shortId: string;
    /** 列表标题：userInput 首行，缺省回落 `TOC <短id>`。 */
    title: string;
    /** 副标题：taskId 短号 · 模型。 */
    subtitle: string;
    modelLabel: string;
    createdAt: number;
    status: TocRowStatus;
    latestAt: number | null;
    adopted: boolean;
    /** 分析倒序（最新在前）。 */
    analyses: TocAnalysisRow[];
    /** 过滤用关键字语料（小写）：输入 / 思维链原文 / taskId / tocId / 各次分析诉求。 */
    searchText: string;
}

/** 迭代记录列表行。 */
export interface IterationRecordRow {
    record: IterationRecordView;
    /** 来源分析的可读标签（`TOC <短id> · 第 N 次分析`）；无来源为 ''。 */
    sourceLabel: string;
    /** 来源 TOC 完整 id（无来源为 ''；用于跳回思维链详情）。 */
    tocId: string;
    /** 来源 TOC 短 id（无来源为 ''）。 */
    tocShortId: string;
}

export interface IterationCounts {
    tocs: number;
    analyses: number;
    records: number;
    byStatus: Record<IterationStatus, number>;
}

export interface IterationBoard {
    /** TOC 倒序（最新冻结在前，与服务端 buildIterations 一致）。 */
    tocs: TocRow[];
    /** 迭代记录按 updatedAt 倒序。 */
    records: IterationRecordRow[];
    counts: IterationCounts;
}

export interface IterationBoardInput {
    iterations: TocIterationView[];
    records: IterationRecordView[];
}

/** TOC 聚合 + 迭代记录 → 面板视图。 */
export function buildIterationBoard(input: IterationBoardInput): IterationBoard {
    const iterations = input.iterations ?? [];
    const records = (input.records ?? []).slice().sort((a, b) => b.updatedAt - a.updatedAt);
    const recordByAnalyze = new Map(records.map((record) => [record.analyzeId ?? '', record]));
    const tocByToc = new Map(iterations.map((item) => [item.toc.tocId, item]));
    const byStatus = emptyStatusCounts();
    for (const record of records) {
        byStatus[record.status] = (byStatus[record.status] ?? 0) + 1;
    }
    const tocs = iterations.map((item) => toTocRow(item, recordByAnalyze));
    return {
        tocs,
        records: records.map((record) => toRecordRow(record, tocByToc, iterations)),
        counts: {
            tocs: tocs.length,
            analyses: tocs.reduce((sum, row) => sum + row.analyses.length, 0),
            records: records.length,
            byStatus,
        },
    };
}

/** TOC 过滤：状态 + 关键字（输入 / 思维链原文 / taskId / id）。 */
export function filterTocs(
    rows: TocRow[],
    options: { query?: string; status?: TocStatusFilter } = {},
): TocRow[] {
    const status = options.status ?? 'all';
    const query = (options.query ?? '').trim().toLowerCase();
    return rows.filter((row) => {
        if (status !== 'all' && row.status !== status) return false;
        if (query.length === 0) return true;
        return row.searchText.includes(query);
    });
}

/** 迭代记录过滤（状态）。 */
export function filterRecords(
    rows: IterationRecordRow[],
    status: IterationStatusFilter = 'all',
): IterationRecordRow[] {
    return status === 'all' ? rows : rows.filter((row) => row.record.status === status);
}

/** 分析耗时（endedAt − createdAt）；缺失或为负 → null。 */
export function analysisDurationMs(analysis: TocAnalysisView): number | null {
    if (analysis.endedAt === undefined || analysis.endedAt === null) return null;
    const span = analysis.endedAt - analysis.createdAt;
    return span >= 0 ? span : null;
}

/** TOC 聚合状态：取最新一次分析的状态；无分析 = none。 */
export function tocStatusOf(analyses: TocAnalysisView[]): TocRowStatus {
    if (analyses.length === 0) return 'none';
    return analyses[analyses.length - 1]?.status ?? 'none';
}

/** 版本短标签：优先提交短号，回落版本号；dirty 加 `*`；全空 → `—`。 */
export function versionLabel(ref: SystemVersionRef | null | undefined): string {
    if (!ref) return '—';
    const base = ref.commit || ref.version;
    if (!base) return '—';
    return ref.dirty ? `${base}*` : base;
}

/** 版本详情：`version · branch`（省略与短标签重复的版本号）。 */
export function versionDetail(ref: SystemVersionRef | null | undefined): string {
    if (!ref) return '';
    const parts: string[] = [];
    if (ref.version && ref.version !== ref.commit) parts.push(ref.version);
    if (ref.branch) parts.push(ref.branch);
    return parts.join(' · ');
}

function toTocRow(
    item: TocIterationView,
    recordByAnalyze: Map<string, IterationRecordView>,
): TocRow {
    const analyses = item.analyses.map((analysis) => ({
        analysis,
        durationMs: analysisDurationMs(analysis),
        record: recordByAnalyze.get(analysis.analyzeId) ?? null,
    }));
    const adopted = analyses.some((row) => row.record !== null);
    const latestAt = analyses.reduce<number | null>(
        (max, row) => (max === null ? row.analysis.createdAt : Math.max(max, row.analysis.createdAt)),
        null,
    );
    const shortId = shortIdOf(item.toc.tocId);
    return {
        tocId: item.toc.tocId,
        shortId,
        title: firstLineOf(item.toc.userInput) || `TOC ${shortId}`,
        subtitle: [shortIdOf(item.toc.taskId), modelLabelOf(item.toc.model)].filter(Boolean).join(' · '),
        modelLabel: modelLabelOf(item.toc.model),
        createdAt: item.toc.createdAt,
        status: tocStatusOf(item.analyses),
        latestAt,
        adopted,
        analyses: analyses.reverse(),
        searchText: buildSearchText(item),
    };
}

function toRecordRow(
    record: IterationRecordView,
    tocByToc: Map<string, TocIterationView>,
    iterations: TocIterationView[],
): IterationRecordRow {
    const source = findSource(record, tocByToc, iterations);
    return {
        record,
        sourceLabel:
            source === null
                ? ''
                : `TOC ${shortIdOf(source.toc.tocId)} · 第 ${source.analysisIndex + 1} 次分析`,
        tocId: source?.toc.tocId ?? '',
        tocShortId: source === null ? '' : shortIdOf(source.toc.tocId),
    };
}

function findSource(
    record: IterationRecordView,
    tocByToc: Map<string, TocIterationView>,
    iterations: TocIterationView[],
): { toc: TocIterationView['toc']; analysisIndex: number } | null {
    if (!record.analyzeId) return null;
    const owner =
        (record.tocId ? tocByToc.get(record.tocId) : undefined) ??
        iterations.find((item) =>
            item.analyses.some((analysis) => analysis.analyzeId === record.analyzeId),
        );
    if (!owner) return null;
    const index = owner.analyses.findIndex((analysis) => analysis.analyzeId === record.analyzeId);
    return index < 0 ? null : { toc: owner.toc, analysisIndex: index };
}

function buildSearchText(item: TocIterationView): string {
    return [
        item.toc.tocId,
        item.toc.taskId,
        item.toc.userInput,
        item.toc.text,
        ...item.analyses.map((analysis) => analysis.userInput),
    ]
        .filter((part) => typeof part === 'string' && part.length > 0)
        .join('\n')
        .toLowerCase();
}

/** 取首个非空行并截断（列表标题 / 采纳标题共用）。 */
export function firstLineOf(text: string, max = 64): string {
    const line = String(text ?? '')
        .split('\n')
        .map((part) => part.trim())
        .find((part) => part.length > 0);
    return line ? truncate(line, max) : '';
}

function modelLabelOf(model: TocIterationView['toc']['model']): string {
    return model?.modelId || 'default';
}

function shortIdOf(id: string): string {
    return String(id ?? '').slice(0, 8);
}

function truncate(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function emptyStatusCounts(): Record<IterationStatus, number> {
    return { proposed: 0, in_progress: 0, applied: 0, reverted: 0, rejected: 0 };
}
