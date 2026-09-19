/**
 * 失败分类账线协议视图（GET /api/ledger / api/webui 共享）。
 * 结构投影自 @mazi/runtime 的 FailureLedgerEntry（业务侧持久化形态）。
 */
export interface FailureLedgerView {
    failureId: string;
    /** 运行会话 id（rootGoalId）。 */
    sessionId: string;
    goalId?: string;
    taskId?: string;
    /** 失败类别（TaskStopReason：max-steps / driver-error / blocked-tool …）。 */
    kind: string;
    providerId?: string;
    modelId?: string;
    summary?: string;
    tags?: string[];
    createdAt: number;
}
