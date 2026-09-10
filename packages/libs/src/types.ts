/**
 * Shared API contracts between apps/api (server) and apps/webui (client).
 * These types define the wire format of REST/SSE responses and must stay
 * in sync with the serialization shape produced by the server.
 */

// ============================================================
// Conversation domain (apps/api conversations.service)
// ============================================================

/** A single Goal run reference inside a Conversation. */
export interface GoalRunRef {
    rootGoalId: string;
    /** Intake Goal statement (raw user input). */
    input: string;
    createdAt: number;
}

/** Conversation business object returned by the API. */
export interface Conversation {
    conversationId: string;
    title: string;
    userId?: string;
    runs: GoalRunRef[];
    /** Workspace root path; always paired with projectId. */
    workspace?: string;
    /** Project identifier within the workspace; always paired with workspace. */
    projectId?: string;
    createdAt: number;
    updatedAt: number;
    /** When true, hidden from the active list but recoverable. */
    archived?: boolean;
}

// ============================================================
// Workspace / project configuration
// ============================================================

/** A registered workspace project (from workspaces.json). */
export interface Project {
    title: string;
    path: string;
}

// ============================================================
// Provider / model configuration (GET /api/config)
// ============================================================

export interface ProviderModel {
    id: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
    /** 平台价格（USD / 百万 token） */
    pricing?: {
        inputPerMTok?: number;
        outputPerMTok?: number;
        cacheReadPerMTok?: number;
        cacheWritePerMTok?: number;
        currency?: 'USD';
    };
    capabilities?: {
        supportsTools?: boolean;
        supportsReasoning?: boolean;
        supportsVision?: boolean;
    };
}

/** Provider overview returned by configOverview(). */
export interface ProviderOverview {
    id: string;
    vendor?: string;
    models: ProviderModel[];
}

/** GET /api/config response. */
export interface ConfigOverview {
    home: string;
    providers: ProviderOverview[];
    hasProvidersFile: boolean;
}

// ============================================================
// Goal tree snapshot (GET /api/sessions/:id/timeline)
// ============================================================

/** Step kind (aligned with core StepKind). */
export type SnapshotStepKind = 'thinking' | 'intent' | 'tool_call' | 'observation';

/** 厂商层 token 用量（core VendorUsage 的线协议投影）。 */
export interface StepVendorUsage {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
    reasoningOutputTokens?: number;
    /** input + output */
    totalTokens?: number;
    reportedByVendor?: boolean;
}

/** 各 context 段落的原文（截断，供 UI 点击查看；不参与计量）。 */
export interface StepContextContents {
    systemPrompt: string;
    historyUser: string;
    historyAssistant: string;
    toolCalls: string;
    toolSchema: string;
    newInput: string;
    observation: string;
    retrieved: string;
    examples: string;
}

/**
 * Runtime 层 input 估算分段（core RuntimeContextBreakdown 的线协议投影）。
 * 各段之和 = totalContextTokens。
 */
export interface StepRuntimeUsage {
    totalContextTokens: number;
    systemPromptTokens: number;
    /** 聚合 = 下面三个之和（旧数据可能只有该字段） */
    historyTokens: number;
    /** 历史用户消息 */
    historyUserTokens?: number;
    /** 历史 assistant 内容（思考 + 正文） */
    historyAssistantTokens?: number;
    /** 历史 assistant 工具调用参数 */
    toolCallTokens?: number;
    toolSchemaTokens: number;
    newInputTokens: number;
    /** 工具结果回注（input） */
    observationTokens: number;
    retrievedTokens?: number;
    exampleTokens?: number;
    /** systemPromptTokens / totalContextTokens */
    systemPromptRatio?: number;
    /** 0-1，相对 contextWindow */
    contextWindowUtilization?: number;
    /** 相对上一步上下文总量；< 0 表示压缩；每轮首次调用为 0 */
    contextDeltaFromPrev?: number;
    strategyApplied?: string[];
    budgetPressureAction?: string;
    /** totalContextTokens − vendor.inputTokens（有符号） */
    estimationDriftTokens?: number;
    /** estimationDriftTokens / vendor.inputTokens */
    estimationDriftRate?: number;
    /** 各段原文（截断，供点击查看） */
    contents?: StepContextContents;
    /** 相对上一轮新增内容（截断） */
    diffContent?: string;
    /** 相对上一轮各段新增内容（截断；首轮含 system prompt / tool schema 全量） */
    diffContents?: StepContextContents;
}

/** Runtime 输出估算与漂移（core UsageEstimate 的线协议投影）。 */
export interface StepEstimateUsage {
    /** 非 reasoning 输出文本的 token 估算 */
    outputTokens: number;
    /** outputTokens − (vendor.output − vendor.reasoning) */
    outputDriftTokens?: number;
    outputDriftRate?: number;
}

/** 成本拆分（core CostBreakdown 的线协议投影）。 */
export interface StepCostUsage {
    inputCostUsd: number;
    outputCostUsd: number;
    cacheWriteCostUsd: number;
    cacheReadCostUsd: number;
    reasoningCostUsd: number;
    totalCostUsd: number;
    priceTierApplied?: string;
    pricingVersion?: string;
    currency?: 'USD';
}

/** 调用耗时（core UsageTiming 的线协议投影）。 */
export interface StepTimingUsage {
    ttftMs: number;
    totalMs: number;
    tokensPerSecond: number;
}

/** Token usage attached to a step (vendor + input estimate + output estimate + cost + timing). */
export interface StepUsage {
    vendor?: StepVendorUsage;
    /** input 估算（breakdown） */
    runtime?: StepRuntimeUsage;
    /** output 估算 */
    estimate?: StepEstimateUsage;
    /** vendor token 口径成本 */
    cost?: StepCostUsage;
    /** 估算 token 口径成本（对照） */
    estimatedCost?: StepCostUsage;
    timing?: StepTimingUsage;
}

/** A single step in the goal-tree snapshot. */
export interface StepView {
    stepId: string;
    goalId: string;
    taskId: string;
    kind: SnapshotStepKind;
    status: string;
    startedAt: number;
    endedAt?: number;
    /** Full payload content (thinking/intent text, tool output). */
    content?: string;
    /** Tool name (for tool_call steps). */
    toolName?: string;
    /** Payload summary (≤240 chars) for audit/log display. */
    payloadText?: string;
    /** Token usage (vendor + runtime). */
    usage?: StepUsage;
}

/** A task node in the goal-tree snapshot. */
export interface TaskNodeView {
    taskId: string;
    status: string;
    title: string;
    steps: StepView[];
}

/** A goal node in the goal-tree snapshot. */
export interface GoalNodeView {
    goalId: string;
    kind: 'intake' | 'work';
    status: string;
    statement: string;
    tasks: TaskNodeView[];
}

/** Full goal-tree snapshot returned by GET /api/sessions/:id/timeline. */
export interface GoalTreeSnapshot {
    rootGoalId: string;
    goals: GoalNodeView[];
    taskCount: number;
    stepCount: number;
}

// ============================================================
// Events (SSE /api/events/:id)
// ============================================================

/** A single event item from the event stream or history. */
export interface EventItem {
    eventId: string;
    type: string;
    [key: string]: unknown;
}
