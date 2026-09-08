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

/** Runtime 层上下文分段计数 */
export interface RuntimeContextBreakdown {
    systemPromptTokens: number;
    /** systemPromptTokens / totalContextTokens */
    systemPromptRatio: number;
    historyTokens: number;
    toolSchemaTokens: number;
    newInputTokens: number;
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
    /** 由 Aggregator 回填：|totalContextTokens − vendor.inputTokens| */
    estimationDriftTokens?: number;
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
    runtime: RuntimeContextBreakdown;
    cost: CostBreakdown;
    timing: UsageTiming;
}
