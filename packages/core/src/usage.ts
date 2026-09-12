/** 厂商层 Usage（账单口径，与 OTel GenAI semconv 对齐） */
export interface VendorUsage {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
    reasoningOutputTokens?: number;
    /** false 时由 Runtime 估算并标注 */
    reportedByVendor: boolean;
}

/** 各 context 段落的原文（按段截断，供 UI 点击查看；不参与计量） */
export interface ContextSegmentContents {
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
 * Runtime 层上下文分段计数（**只描述 input 的估算**）。
 * 各段之和 = totalContextTokens；输出侧估算见 UsageEstimate。
 */
export interface RuntimeContextBreakdown {
    systemPromptTokens: number;
    /** systemPromptTokens / totalContextTokens */
    systemPromptRatio: number;
    /** 历史消息聚合 = historyUserTokens + historyAssistantTokens + toolCallTokens */
    historyTokens: number;
    /** 历史用户消息 */
    historyUserTokens?: number;
    /** 历史 assistant 内容（思考 + 正文） */
    historyAssistantTokens?: number;
    /** 历史 assistant 工具调用参数（JSON） */
    toolCallTokens?: number;
    toolSchemaTokens: number;
    newInputTokens: number;
    /** 工具结果回注（role=tool），属于下一轮 input */
    observationTokens: number;
    retrievedTokens: number;
    exampleTokens: number;
    totalContextTokens: number;
    /** 0-1 */
    contextWindowUtilization: number;
    /** 负值 = 压缩生效 */
    contextDeltaFromPrev: number;
    strategyApplied: ContextStrategyAction[];
    budgetPressureAction?: 'truncate' | 'summarize' | 'drop-observation' | 'escalate';
    /** 由 Aggregator 回填：totalContextTokens − vendor.inputTokens（有符号） */
    estimationDriftTokens?: number;
    /** estimationDriftTokens / vendor.inputTokens */
    estimationDriftRate?: number;
    /** 各段原文（截断，供点击查看） */
    contents?: ContextSegmentContents;
    /** 相对上一轮新增内容（截断；首轮为 newInput） */
    diffContent?: string;
    /** 相对上一轮各段新增内容（截断；首轮含 system prompt / tool schema 全量） */
    diffContents?: ContextSegmentContents;
}

/** 输出各段原文（截断，供 UI 查看；不参与计量） */
export interface OutputSegmentContents {
    reasoning: string;
    /** tool_call 参数（JSON 行） */
    toolCalls: string;
    text: string;
    /** 预留：多模态输出 */
    image?: string;
    video?: string;
}

/**
 * Runtime 输出分段计数：reasoning / tool-call args / text（image/video 预留）。
 * 第 N 轮产出的 tool_call 参数属于**本轮 output**，不是下一轮 input。
 */
export interface RuntimeOutputBreakdown {
    reasoningTokens: number;
    toolCallArgsTokens: number;
    textTokens: number;
    imageTokens?: number;
    videoTokens?: number;
    totalOutputTokens: number;
    contents?: OutputSegmentContents;
}

/** 本轮计价快照（入库；审计可据此重算 vendor 成本分解）。 */
export interface PricingSnapshot {
    /** 生效倍率后的单价（$/MTok） */
    inputPerMTok: number;
    cachedInputPerMTok: number;
    outputPerMTok: number;
    reasoningPerMTok?: number;
    currency: 'USD';
    version: string;
    tier: string;
}

/** Runtime 输出侧估算（非 reasoning 输出文本） */
export interface UsageEstimate {
    /** 用同一 tokenizer 对非 reasoning 输出文本的估算 */
    outputTokens: number;
    /** outputTokens − (vendor.output − vendor.reasoning)（有符号） */
    outputDriftTokens?: number;
    /** outputDriftTokens / (vendor.output − vendor.reasoning) */
    outputDriftRate?: number;
}

/** Context 策略动作 */
export type ContextStrategyAction =
    | 'sliding-window'
    | 'summarize-history'
    | 'retrieve-fresh'
    | 'compress-observation'
    | 'drop-tool-schema'
    | 'cache-prompt-prefix';

/** 成本拆分 */
export interface CostBreakdown {
    inputCostUsd: number;
    outputCostUsd: number;
    cacheWriteCostUsd: number;
    cacheReadCostUsd: number;
    reasoningCostUsd: number;
    totalCostUsd: number;
    /** 命中的 PricingTier.name */
    priceTierApplied: string;
    pricingVersion: string;
    currency: 'USD';
    calculatedAt: number;
}

/** 调用耗时 */
export interface UsageTiming {
    ttftMs: number;
    totalMs: number;
    tokensPerSecond: number;
}

/** Step 上挂载的完整 Usage */
export interface Usage {
    vendor: VendorUsage;
    /** input 估算 */
    runtime: RuntimeContextBreakdown;
    /** output 估算与漂移 */
    estimate: UsageEstimate;
    /** 输出分段估算（reasoning / tool-call args / text） */
    output?: RuntimeOutputBreakdown;
    /** 本轮计价快照（生效倍率后的单价） */
    pricing?: PricingSnapshot;
    /** vendor token 口径成本 */
    cost: CostBreakdown;
    /** runtime 估算 token 口径成本（对照） */
    estimatedCost: CostBreakdown;
    timing: UsageTiming;
}
