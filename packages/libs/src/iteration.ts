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
