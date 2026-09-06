/** 失败分类账记录：供人工 review / 报告识别高频失败模式 */
export interface FailureLedgerRecord {
    recordId: string;
    sessionId: string;
    turnId?: string;
    stepId?: string;
    failureKind: string;
    costUsd?: number;
    providerId?: string;
    tags: string[];
    summary?: string;
    createdAt: number;
}
