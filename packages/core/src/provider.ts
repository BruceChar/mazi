import type { ToolSpec } from './capacity';
import type { VendorUsage } from './usage';

/** 硬能力标签 */
export type CapabilityTag = 'tools' | 'vision' | 'thinking' | 'long-context';

/** Provider 能力标签 */
export type ProviderTag = CapabilityTag;

/** 业务专长标签 */
export type SpecialtyTag =
    | 'frontend-ui-generation'
    | 'scenario-dialogue'
    | 'scientific-research'
    | 'code-refactoring'
    | 'data-analysis'
    | 'creative-writing'
    | 'math-reasoning'
    | 'multimodal-understanding'
    | 'long-document-analysis'
    | 'tool-use-reliability'
    | 'fast-classification'
    | 'summarization'
    | 'translation'
    | (string & {});

/** 模型引用：定位池中的一个具体模型 */
export interface ModelRef {
    providerId: string;
    vendor: string;
    modelId: string;
}

/** Provider 实例：带业务画像、分时定价与健康度的路由决策源 */
export interface Provider {
    id: string;
    vendor: string;
    models: ModelDescriptor[];
    /** 硬能力标签 */
    tags: ProviderTag[];
    limits: {
        rpm?: number;
        tpm?: number;
        concurrency?: number;
    };
    /** 业务专长标签（语义路由信号） */
    specialties: SpecialtyTag[];
    /** 性能画像（Runtime 滚动统计自动填充） */
    performance: PerformanceProfile;
    /** 分时定价 */
    pricing: PricingSchedule;
    /** 经济性画像（含 Tag 细分） */
    economics: EconomicsProfile;
    /** 兼容保留，逐步被 pricing/economics 取代 */
    costWeight: number;
    health: {
        score: number;
        lastErrorAt?: number;
    };
}

/** 模型描述 */
export interface ModelDescriptor {
    id: string;
    contextWindow: number;
    supportsTools: boolean;
    supportsThinking: boolean;
    supportsVision: boolean;
}

/** 性能百分位 */
export interface Percentile {
    p50: number;
    p90: number;
    p95: number;
    p99?: number;
}

/** Provider 性能画像 */
export interface PerformanceProfile {
    tokensPerSecond: Percentile;
    /** 首 token 延迟 */
    ttftMs: Percentile;
    e2eLatencyMs: Percentile;
    /** 滚动错误率 0-1 */
    errorRate: number;
    /** 该模型生成 toolCall 的 schema 遵从率 */
    toolCallSchemaCompliance: number;
    /** 样本数（低于阈值时路由降权） */
    sampleSize: number;
    /** 滚动窗口，如 3600_000 */
    windowMs: number;
    lastUpdated: number;
}

/** 分时定价表 */
export interface PricingSchedule {
    currency: 'USD';
    base: {
        inputPerMTok: number;
        outputPerMTok: number;
        cacheWritePerMTok?: number;
        cacheReadPerMTok?: number;
        reasoningPerMTok?: number;
    };
    /** 时段档位：请求时刻命中的第一个 tier 生效 */
    tiers: PricingTier[];
    effectiveAt: number;
    version: string;
}

/** 单个价格档位 */
export interface PricingTier {
    name: string;
    /** UTC 小时区间，半开区间语义 [start, end) */
    windowHoursUtc: [number, number];
    /** 0.5 = 半价，1.2 = 高峰加价 */
    multiplier: number;
    appliesTo?: ('input' | 'output' | 'cache-write' | 'cache-read' | 'reasoning')[];
}

/** Provider 经济性画像 */
export interface EconomicsProfile {
    avgTaskCostUsd: number;
    avgTokensPerTurn: {
        input: number;
        output: number;
    };
    /** cost / 平均评估分，越低越好 */
    costPerQualityScore: number;
    retryRate: number;
    sampleSize: number;
    /** 按 specialtyTag 细分的画像 */
    perTag?: Record<string, TagEconomics>;
    lastUpdated: number;
}

/** 单 Tag 经济画像 */
export interface TagEconomics {
    avgTokensPerTurn: {
        input: number;
        output: number;
    };
    avgTaskCostUsd: number;
    successRate: number;
    /** < 30 时该 tag 维度评分回退到 Provider 整体画像 */
    sampleSize: number;
}

/** 统一的 LLM 消息 */
export interface LLMMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    name?: string;
    toolCallId?: string;
}

/** 与 pi-ai Context 对齐的统一上下文 */
export interface LLMContext {
    systemPrompt?: string;
    messages: LLMMessage[];
    tools: ToolSpec[];
}

/** LLM 调用请求 */
export interface LLMRequest {
    model: ModelRef;
    context: LLMContext;
    thinking?: {
        budgetTokens?: number;
    };
    maxTokens?: number;
    signal?: AbortSignal;
}

/** 非流式 LLM 响应 */
export interface LLMResponse {
    content: string;
    finishReason?: string;
    usage?: VendorUsage;
    model?: ModelRef;
}

/** 流式 LLM 事件 */
export type LLMStreamEvent =
    | { type: 'text-delta'; delta: string }
    | { type: 'reasoning-delta'; delta: string }
    | {
          type: 'tool-call';
          callId: string;
          toolName: string;
          arguments: Record<string, unknown>;
      }
    | { type: 'usage'; usage: VendorUsage }
    | { type: 'end'; finishReason: string };

/** LLM 调用统一入口，由 provider-llm 包实现 */
export interface LLMDriver {
    /** 流式调用：返回事件流，由 Executor 消费 */
    stream(req: LLMRequest): AsyncIterable<LLMStreamEvent>;
    /** 非流式调用 */
    complete(req: LLMRequest): Promise<LLMResponse>;
}
