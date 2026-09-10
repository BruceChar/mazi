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
    /** vendor token 口径成本 */
    cost: CostBreakdown;
    /** runtime 估算 token 口径成本（对照） */
    estimatedCost: CostBreakdown;
    timing: UsageTiming;
}
