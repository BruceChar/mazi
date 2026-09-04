/** 用户交互记录：在用户输入完成后立即创建，Session 过程中持续更新 */
export interface UserInteractionRecord {
    recordId: string;
    sessionId: string;
    /** 用户标识（如有）；匿名化场景可省略 */
    userId?: string;
    /** 用户原始输入（完整保留） */
    rawInput: string;
    inputTimestamp: number;
    intent?: {
        category?: string;
        confidence?: number;
        entities?: Record<string, string[]>;
    };
    thoughtTrace: ThoughtSummary[];
    actionTrace: ActionSummary[];
    feedback: UserFeedback[];
    outcome?: {
        status: 'success' | 'failed' | 'aborted' | 'timeout';
        summary?: string;
    };
    tags?: string[];
    metrics: {
        durationMs?: number;
        totalTokens?: number;
        totalCostUsd?: number;
        turnCount?: number;
    };
    status: 'recording' | 'completed';
    updatedAt: number;
}

/** 思考摘要 */
export interface ThoughtSummary {
    stepSeq: number;
    /** 不超过 200 字符的概括 */
    summary: string;
    category?: 'planning' | 'reasoning' | 'self-correction' | 'reflection';
}

/** 行为摘要 */
export interface ActionSummary {
    stepSeq: number;
    actionType: 'tool_call' | 'provider_switch' | 'strategy_switch' | 'approval';
    description: string;
    result?: 'ok' | 'error' | 'blocked';
}

/** 用户反馈 */
export interface UserFeedback {
    timestamp: number;
    type: 'decision_change' | 'authorization' | 'output_rating' | 'text_feedback';
    content?: string;
    /** 评分（1-5），仅 output_rating 使用 */
    rating?: number;
    target?: {
        turnId?: string;
        stepId?: string;
    };
}
