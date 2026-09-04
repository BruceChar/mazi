import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
    EconomicsProfile,
    LLMDriver,
    ModelDescriptor,
    PerformanceProfile,
    PricingSchedule,
    Provider,
    VendorUsage,
} from '@mazi/core';
import type { ScriptedDriverOptions } from './driver.js';
import { ScriptedDriver } from './driver.js';

/** 脚本化工具调用声明（ScriptedRound.toolCalls 的元素） */
export interface ScriptedToolCall {
    callId: string;
    toolName: string;
    arguments: Record<string, unknown>;
}

/** 脚本化单轮输出：text/reasoning/toolCalls 任选组合；usage/finishReason 可选 */
export interface ScriptedRound {
    text?: string;
    reasoning?: string;
    toolCalls?: ScriptedToolCall[];
    usage?: VendorUsage;
    finishReason?: string;
}

/** scenarioFile 的内容结构：{ rounds, failCalls? } */
export interface ScenarioFile {
    rounds: ScriptedRound[];
    failCalls?: number;
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
    /** 驱动配置：MVP 仅 scripted；rounds 与 scenarioFile 二选一（scenarioFile 优先） */
    driver?: {
        type?: 'scripted';
        rounds?: ScriptedRound[];
        scenarioFile?: string;
        failCalls?: number;
    };
    /** 分时定价（缺省字段由 normalizeProvider 补默认值） */
    pricing?: Partial<PricingSchedule>;
    health?: {
        score?: number;
        lastErrorAt?: number;
    };
    /** 兼容保留的成本权重，缺省 1 */
    costWeight?: number;
}

/** base 缺省单价 input/output = 1/3（与 MVP 文档 §9 示例 0.5/1.5 的 1:3 比例一致） */
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

/** 读取 scenarioFile（相对 process.cwd()）：{ rounds, failCalls? } */
function loadScenarioFile(scenarioFile: string): ScenarioFile {
    const absolutePath = resolve(process.cwd(), scenarioFile);
    let raw: string;
    try {
        raw = readFileSync(absolutePath, 'utf8');
    } catch (error) {
        throw new Error(
            `ScriptedDriverRegistry: scenarioFile 读取失败 "${scenarioFile}"（${absolutePath}）：${(error as Error).message}`,
        );
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(
            `ScriptedDriverRegistry: scenarioFile "${scenarioFile}" 不是合法 JSON：${(error as Error).message}`,
        );
    }
    const scenario = parsed as Partial<ScenarioFile>;
    if (!Array.isArray(scenario.rounds)) {
        throw new Error(`ScriptedDriverRegistry: scenarioFile "${scenarioFile}" 缺少 rounds 数组`);
    }
    const result: ScenarioFile = { rounds: scenario.rounds as ScriptedRound[] };
    if (scenario.failCalls !== undefined) {
        result.failCalls = scenario.failCalls;
    }
    return result;
}

/** 驱动工厂：由归一化 Provider + 原始配置 JSON 构造 LLMDriver */
export interface DriverRegistry {
    build(provider: Provider, json: ProviderJson): LLMDriver;
}

/**
 * scripted 驱动注册表（MVP 唯一实现，MVP 文档 §3.2/§8 F5）：
 * scenarioFile 存在时读取它（相对 cwd 的 { rounds, failCalls? }，优先于
 * driver.rounds）；failCalls 取 driver.failCalls ?? scenarioFile.failCalls ?? 0。
 */
export class ScriptedDriverRegistry implements DriverRegistry {
    build(_provider: Provider, json: ProviderJson): LLMDriver {
        const driver = json.driver;
        const type = driver?.type ?? 'scripted';
        if (type !== 'scripted') {
            throw new Error(
                `ScriptedDriverRegistry: 不支持的 driver.type "${type}"（MVP 仅 scripted）`,
            );
        }
        const scenario = driver?.scenarioFile ? loadScenarioFile(driver.scenarioFile) : undefined;
        const options: ScriptedDriverOptions = {
            rounds: scenario ? scenario.rounds : (driver?.rounds ?? []),
            failCalls: driver?.failCalls ?? scenario?.failCalls ?? 0,
        };
        return new ScriptedDriver(options);
    }
}
