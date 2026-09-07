import type {
    EconomicsProfile,
    LLMDriver,
    ModelDescriptor,
    PerformanceProfile,
    PricingSchedule,
    Provider,
} from '@mazi/core';

/** pi-ai 真实厂商驱动配置段 */
export interface PiAiDriverJson {
    type: 'pi-ai';
    /** pi-ai provider id（openai/deepseek/...），缺省 openai */
    provider?: string;
    /** 厂商模型名（须在 pi-ai 目录内） */
    model?: string;
    /** API key 环境变量名；缺省按 provider 默认 env（OPENAI_API_KEY/DEEPSEEK_API_KEY…） */
    apiKeyEnv?: string;
}

/** providers 配置 JSON 的单条 Provider（driver 段为 provider-llm 私有扩展） */
export interface ProviderJson {
    id: string;
    vendor: string;
    /** 硬能力标签（CapabilityTag），缺省 [] */
    tags?: string[];
    /** 业务专长标签（SpecialtyTag），缺省 [] */
    specialties?: string[];
    models: ModelDescriptor[];
    driver?: PiAiDriverJson;
    /** 分时定价（缺省字段由 normalizeProvider 补默认值） */
    pricing?: Partial<PricingSchedule>;
    health?: {
        score?: number;
        lastErrorAt?: number;
    };
    /** 兼容保留的成本权重，缺省 1 */
    costWeight?: number;
}

/** base 缺省单价（USD / 1M token）。 */
const DEFAULT_INPUT_PER_MTok = 1;
const DEFAULT_OUTPUT_PER_MTok = 3;

/** 滚动统计缺省窗口（1h，与 core PerformanceProfile 注释一致） */
const DEFAULT_WINDOW_MS = 3_600_000;

function defaultPerformance(now: number): PerformanceProfile {
    return {
        tokensPerSecond: { p50: 0, p90: 0, p95: 0 },
        ttftMs: { p50: 0, p90: 0, p95: 0 },
        e2eLatencyMs: { p50: 0, p90: 0, p95: 0 },
        errorRate: 0,
        toolCallSchemaCompliance: 1,
        sampleSize: 0,
        windowMs: DEFAULT_WINDOW_MS,
        lastUpdated: now,
    };
}

function defaultEconomics(now: number): EconomicsProfile {
    return {
        avgTaskCostUsd: 0,
        avgTokensPerTurn: { input: 0, output: 0 },
        costPerQualityScore: 0,
        retryRate: 0,
        sampleSize: 0,
        lastUpdated: now,
    };
}

/**
 * ProviderJson → 归一化 Provider：补齐 performance/economics 全默认、
 * pricing 默认（tiers []、base.input/outputPerMTok 缺省 1/3、
 * version '0.0.0'、effectiveAt now）、health.score 缺省 1、
 * costWeight 缺省 1、tags/specialties 缺省 []、limits 恒 {}。
 */
export function normalizeProvider(json: ProviderJson): Provider {
    const pricing = json.pricing;
    const now = Date.now();
    const base = pricing?.base;
    const normalizedBase: PricingSchedule['base'] = {
        inputPerMTok: base?.inputPerMTok ?? DEFAULT_INPUT_PER_MTok,
        outputPerMTok: base?.outputPerMTok ?? DEFAULT_OUTPUT_PER_MTok,
    };
    if (base?.cacheWritePerMTok !== undefined) {
        normalizedBase.cacheWritePerMTok = base.cacheWritePerMTok;
    }
    if (base?.cacheReadPerMTok !== undefined) {
        normalizedBase.cacheReadPerMTok = base.cacheReadPerMTok;
    }
    if (base?.reasoningPerMTok !== undefined) {
        normalizedBase.reasoningPerMTok = base.reasoningPerMTok;
    }
    const health: Provider['health'] = { score: json.health?.score ?? 1 };
    if (json.health?.lastErrorAt !== undefined) {
        health.lastErrorAt = json.health.lastErrorAt;
    }
    return {
        id: json.id,
        vendor: json.vendor,
        models: json.models,
        tags: (json.tags ?? []) as Provider['tags'],
        limits: {},
        specialties: (json.specialties ?? []) as Provider['specialties'],
        performance: defaultPerformance(now),
        pricing: {
            currency: 'USD',
            base: normalizedBase,
            tiers: pricing?.tiers ?? [],
            effectiveAt: pricing?.effectiveAt ?? now,
            version: pricing?.version ?? '0.0.0',
        },
        economics: defaultEconomics(now),
        costWeight: json.costWeight ?? 1,
        health,
    };
}

/** 驱动工厂：由归一化 Provider + 原始配置 JSON 构造 LLMDriver */
export interface DriverRegistry {
    build(provider: Provider, json: ProviderJson): LLMDriver;
}

export { DefaultDriverRegistry } from './default-registry.js';
