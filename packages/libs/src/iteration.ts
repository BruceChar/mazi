/**
 * Iterations —— TOC（冻结 thinking 链）与独立 Agent 分析记录的线协议视图。
 *
 * 关系：TocRecord 1 ── N TocAnalysis（每次 analyze 一条）1 ── N TocFeedback（用户对某次分析的反馈）。
 * 存储与执行归 @mazi/runtime（SQLite + 独立 provider 调用）；本文件只定义 api/webui 共享的视图形状。
 */

export type TocAnalysisStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface TocModelRef {
    providerId: string;
    modelId: string;
}

/** 冻结的 thinking 链快照（独立审计/评估的输入单元）。 */
export interface TocRecordView {
    tocId: string;
    taskId: string;
    goalId: string;
    rootGoalId: string;
    /** 创建 toc 时的用户输入。 */
    userInput: string;
    /** 产生该 toc 的模型（如有）。 */
    model?: TocModelRef;
    /** renderThinkingChain 冻结文本。 */
    text: string;
    createdAt: number;
}

/** 用户对某次分析的反馈。 */
export interface TocFeedbackView {
    feedbackId: string;
    analyzeId: string;
    content: string;
    rating?: number;
    createdAt: number;
}

/** 对某个 toc 的一次独立 Agent 分析。 */
export interface TocAnalysisView {
    analyzeId: string;
    tocId: string;
    /** 本次分析的用户诉求（instructions）。 */
    userInput: string;
    model?: TocModelRef;
    status: TocAnalysisStatus;
    output: string;
    error?: string;
    createdAt: number;
    endedAt?: number;
    feedback: TocFeedbackView[];
}

/** Iterations 面板消费的聚合视图：toc + 其下全部分析（含反馈）。 */
export interface TocIterationView {
    toc: TocRecordView;
    analyses: TocAnalysisView[];
}

/** 迭代记录钉住的系统版本快照（轻量、随记录落库）。 */
export interface SystemVersionRef {
    /** `git describe --tags --always`；无 git 时回落 package.json version */
    version: string;
    /** 提交短号；无 git 时为 '' */
    commit: string;
    branch: string;
    /** 读取时工作区是否有未提交改动 */
    dirty: boolean;
}

/** GET /api/system/info：面板「系统」页展示的完整版本与构建信息。 */
export interface SystemVersionView extends SystemVersionRef {
    commitSubject: string;
    commitDate: string;
    packageVersion: string;
    node: string;
    platform: string;
    readAt: number;
}

export type IterationStatus = 'proposed' | 'in_progress' | 'applied' | 'reverted' | 'rejected';

/** 一条系统迭代记录（分析报告 → 系统改动）的完整视图。 */
export interface IterationRecordView {
    iterationId: string;
    analyzeId?: string;
    tocId?: string;
    title: string;
    intent: string;
    status: IterationStatus;
    base: SystemVersionRef;
    applied?: SystemVersionRef;
    notes: string;
    createdAt: number;
    updatedAt: number;
}

/** 迭代记录的状态展示顺序（过滤 chips / 计数）。 */
export const ITERATION_STATUSES: readonly IterationStatus[] = [
    'proposed',
    'in_progress',
    'applied',
    'reverted',
    'rejected',
];

/**
 * 唯一合法迁移表（前后端共用，见 docs/web/迭代面板设计.md §2.3）：
 * 服务端据此校验 PATCH，前端据此决定展示哪些动作按钮，避免两处状态机漂移。
 */
export const ITERATION_TRANSITIONS: Record<IterationStatus, readonly IterationStatus[]> = {
    proposed: ['in_progress', 'rejected'],
    in_progress: ['applied', 'rejected'],
    applied: ['reverted'],
    reverted: ['in_progress'],
    rejected: ['proposed'],
};

/** from → to 是否为设计允许的迁移（同状态视为合法空操作）。 */
export function canTransition(from: IterationStatus, to: IterationStatus): boolean {
    return from === to || ITERATION_TRANSITIONS[from].includes(to);
}
