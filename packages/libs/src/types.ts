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

/**
 * 价目表视图（configOverview 投影）：base = 基础/空闲单价，tiers = 分时段倍率
 * （如 DeepSeek 高峰 ×2）；人民币价来自官网抓取，USD 来自 pi-ai 目录。
 */
export interface ProviderPricingView {
    currency?: 'USD' | 'CNY';
    base: {
        inputPerMTok?: number;
        outputPerMTok?: number;
        cacheReadPerMTok?: number;
        cacheWritePerMTok?: number;
        reasoningPerMTok?: number;
    };
    tiers?: Array<{
        name: string;
        /** UTC 小时半开区间 [start, end)；start > end 表示跨午夜 */
        windowHoursUtc: [number, number];
        multiplier: number;
        /** 生效 UTC 星期（0=周日..6=周六）；缺省 = 每天 */
        weekdays?: number[];
    }>;
    version?: string;
    effectiveAt?: number;
}

export interface ProviderModel {
    id: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
    /** 该模型价目（优先入库的官方分时价，缺省回退目录价） */
    pricing?: ProviderPricingView;
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
    /** provider 级价目（缺省模型的价目；逐模型价见 models[].pricing） */
    pricing?: ProviderPricingView;
    models: ProviderModel[];
}

/** GET /api/config response. */
export interface ConfigOverview {
    home: string;
    providers: ProviderOverview[];
    hasProvidersFile: boolean;
    /** Free-chat default workspace (backend-persisted). */
    freeChatWorkspace?: string;
    /** System-level permission grant (Settings → General, backend-persisted). */
    permissionCeiling?: string;
    /** Scoped permission overrides: `workspace:<path>` / `conversation:<id>`. */
    permissions?: Record<string, string>;
    /** @deprecated 旧版单一价目源；等价于 pricingSources.deepseek。 */
    pricingSourceUrl?: string;
    /** 各厂商（vendor）官方价目源：vendor → URL（Settings → Providers 下按 vendor 配置）。 */
    pricingSources?: Record<string, string>;
    /** provider id → 已配置 API Key 的遮蔽形态（中间隐私；明文不回显）。 */
    apiKeyMasked?: Record<string, string>;
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
    /** 实际装配进请求的上下文字节数（UTF-8；入库原始事实） */
    contextBytes?: number;
    /** 本次采用的模型上下文窗口（token） */
    contextWindowTokens?: number;
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

/** 输出各段原文（截断） */
export interface StepOutputContents {
    reasoning: string;
    toolCalls: string;
    text: string;
    image?: string;
    video?: string;
}

/** Runtime 输出分段（reasoning / tool-call args / text；image/video 预留）。 */
export interface StepOutputUsage {
    reasoningTokens: number;
    toolCallArgsTokens: number;
    textTokens: number;
    imageTokens?: number;
    videoTokens?: number;
    totalOutputTokens: number;
    contents?: StepOutputContents;
}

/** 本轮计价快照（生效倍率后的单价，$/MTok）。 */
export interface StepPricingUsage {
    inputPerMTok: number;
    cachedInputPerMTok: number;
    outputPerMTok: number;
    reasoningPerMTok?: number;
    currency?: 'USD' | 'CNY';
    version?: string;
    tier?: string;
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
    currency?: 'USD' | 'CNY';
}

/** 调用耗时（core UsageTiming 的线协议投影）。 */
export interface StepTimingUsage {
    ttftMs: number;
    totalMs: number;
    tokensPerSecond: number;
}

/**
 * 原始轮次事实（入库优先）：provider/model + 原始 token 计数 + 耗时。
 * 展示/计价可从它重算——即使 UI 或算法演进，也不依赖当时算出的派生值。
 */
export interface StepRawUsage {
    providerId?: string;
    modelId?: string;
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    cachedWriteInputTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
    ttftMs?: number;
    totalMs?: number;
}

/** 派发钉死的目录三元组（offering × pricingPlan × epoch）。 */
export interface StepPin {
    offeringId?: string;
    pricingPlanId?: string;
    catalogEpoch?: number;
}

/** Token usage attached to a step (vendor + input estimate + output estimate + cost + timing). */
export interface StepUsage {
    /**
     * 轮次标识：一轮模型调用可能产生 thinking 与 intent 两个 step，挂载同一份 usage。
     * 聚合统计按 roundId 去重（一轮只计一次），单步展示仍可读到完整 usage。
     */
    roundId?: string;
    /** 原始轮次事实（provider/model + 原始 token + 耗时）；展示/计价可从它重算 */
    raw?: StepRawUsage;
    /** 目录钉死三元组（账务/追溯） */
    pin?: StepPin;
    vendor?: StepVendorUsage;
    /** input 估算（breakdown） */
    runtime?: StepRuntimeUsage;
    /** output 估算 */
    estimate?: StepEstimateUsage;
    /** 输出分段估算（reasoning / tool-call args / text） */
    output?: StepOutputUsage;
    /** 本轮计价快照（入库；审计重算 vendor 成本分解） */
    pricing?: StepPricingUsage;
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
    /** Tool call arguments (for tool_call steps; 展示命令/参数). */
    toolArguments?: Record<string, unknown>;
    /** 工具实际执行的工作目录（tool_call steps）. */
    toolCwd?: string;
    /** Tool call output text (for tool_call steps). */
    toolOutput?: string;
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
    /** Task 开始时间（executor 进入 running 时落库；旧数据缺省） */
    startedAt?: number;
    /** Task 结束时间（进入终态时落库） */
    endedAt?: number;
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
