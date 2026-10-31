/**
 * Shared API contracts between apps/api (server) and apps/webui (client).
 * These types define the wire format of REST/SSE responses and must stay
 * in sync with the serialization shape produced by the server.
 */

// 用户行为指令的线协议视图在 behavior.ts 定义；此处仅类型引用，不构成运行时环。
import type { UserBehaviorView } from './behavior.js';

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
    /** provider id → 实际生效的 Key 来源（configured=配置的 Key / env=环境变量 / none）。 */
    apiKeySource?: Record<string, 'configured' | 'env' | 'none'>;
    /** 存储路径（/api/config 附加；Settings → Storage 展示）。 */
    storage?: {
        driver: string;
        db: string;
        events: string;
        /** 用户行为流目录（append-only 用户资产）。 */
        behavior: string;
    };
}

// ============================================================
// Goal tree snapshot (GET /api/sessions/:id/timeline)
// ============================================================

/** Step kind (aligned with core StepKind). */
export type SnapshotStepKind = 'deliberation' | 'invocation';

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
    /** 估算 input 成本采用的缓存命中率（0-1，初始 0.9，按会话随 vendor 更新） */
    cachedRatio?: number;
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
     * 轮次标识：挂在该轮 deliberation step 上（一轮只产生一个模型输出步）。
     * 聚合统计按 roundId 去重（一轮只计一次）。
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
    /** 主文本：deliberation 为 answer（无 answer 时回落 thinking）；invocation 为 output。 */
    content?: string;
    /** deliberation 的推理文本（thinking）。 */
    thinking?: string;
    /** deliberation 的模型回答（answer）。 */
    answer?: string;
    /** Tool name (for invocation steps). */
    toolName?: string;
    /** Tool call arguments (for invocation steps; 展示命令/参数). */
    toolArguments?: Record<string, unknown>;
    /** 工具实际执行的工作目录（invocation steps）. */
    toolCwd?: string;
    /** Tool call output text (for invocation steps). */
    toolOutput?: string;
    /** Payload summary (≤240 chars) for audit/log display. */
    payloadText?: string;
    /** Token usage (vendor + runtime). */
    usage?: StepUsage;
}

/** 条款级机械检查规格（wire 视图；与 core ConditionCheck 同形）。 */
export type ContractConditionCheck = { kind: 'final-answer' } | { kind: 'no-failed-steps' };

/** 一条验收条款的线协议视图。 */
export interface ContractConditionView {
    id: string;
    checkType: 'deterministic' | 'semantic';
    description?: string;
    check?: ContractConditionCheck;
}

/** Goal 冻结契约的线协议视图。审批人/评估器/审计员的参照物（裁决 D8）。 */
export interface ContractView {
    successConditions: ContractConditionView[];
    failureConditions: ContractConditionView[];
    forbiddenResources: { kind: string; pattern: string }[];
    budget: {
        maxTokens?: number;
        maxCostUsd?: number;
        maxSteps?: number;
        maxTurns?: number;
        timeoutMs?: number;
        reserveRatio?: number;
    };
    terminationPolicy: {
        maxTurns?: number;
        maxSteps?: number;
        maxCostUsd?: number;
        timeoutMs?: number;
    };
    riskProfile: {
        hasIrreversibleActions: boolean;
        touchesNetwork: boolean;
        touchesExternalApi: boolean;
    };
    /** successConditions 中 deterministic 占比（健康度：能用代码判的绝不交给 judge）。 */
    deterministicRatio: number;
}

/** Task 的验收锚定（指向 Goal 契约的条款 id）。 */
export interface AcceptanceView {
    conditions: string[];
    aggregateConditions?: string[];
    description?: string;
}

/** 单条款判定结果。 */
export interface ConditionResultView {
    conditionId: string;
    status: 'passed' | 'failed' | 'unchecked';
    detail?: string;
}

/** 验收判定事实（评估器产出，随 Task 落库）。 */
export interface AcceptanceResultView {
    checkedAt: number;
    passed: boolean;
    evaluated: number;
    total: number;
    conditions: ConditionResultView[];
}

/** 契约满足度（Goal 级机械汇总，评估器角色产出）。 */
export type ContractStateView = 'satisfied' | 'violated' | 'partial' | 'unchecked';

export interface ContractStatusView {
    state: ContractStateView;
    total: number;
    evaluated: number;
    passed: number;
    failed: number;
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
    /** 验收锚定 Goal 契约的哪些条款。 */
    acceptance?: AcceptanceView;
    /** 验收判定事实（评估器写入；旧数据缺省）。 */
    acceptanceResult?: AcceptanceResultView;
    steps: StepView[];
}

/** 协商问题视图（模板要求每问必带默认路径）。 */
export interface NegotiationQuestionView {
    q: string;
    why?: string;
    default: string;
}

export interface NegotiationAnswerView {
    q: string;
    answer: string;
    usedDefault?: boolean;
}

/** 契约协商轨迹视图：Trace 面板重建「条款从哪来、用户答复改了什么」。 */
export interface NegotiationView {
    route: 'direct' | 'confirmed' | 'negotiate' | 'escalate' | 'fallback';
    classifiedBy: 'parser' | 'fallback';
    triggers: string[];
    understanding?: string[];
    defaultPath?: string[];
    questions: NegotiationQuestionView[];
    answers: NegotiationAnswerView[];
    escalation?: string;
    directAnswer?: string;
    /** 0 = 首次冻结，>0 = 协商答复后修订 */
    revision: number;
    resolved: boolean;
    at: number;
}

/** A goal node in the goal-tree snapshot. */
export interface GoalNodeView {
    goalId: string;
    status: string;
    statement: string;
    /** 冻结契约（GoalContract 投影）；执行前承诺的可视化载体。 */
    contract?: ContractView;
    /** 契约协商轨迹（triage 结果 + 用户答复）；旧数据缺省。 */
    negotiation?: NegotiationView;
    /** 契约满足度汇总（机械口径）；未执行/旧数据缺省。 */
    contractStatus?: ContractStatusView;
    tasks: TaskNodeView[];
}

/** Full goal-tree snapshot returned by GET /api/sessions/:id/timeline. */
export interface GoalTreeSnapshot {
    rootGoalId: string;
    goals: GoalNodeView[];
    taskCount: number;
    stepCount: number;
    /**
     * 会话的用户行为指令（append-only 行为流；时间线投影见 projectBehaviorTimeline）。
     * 加法可选字段：无行为时缺省不输出。
     */
    behaviors?: UserBehaviorView[];
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
