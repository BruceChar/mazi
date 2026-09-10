/**
 * ProfileCollector —— 实现 AHF_RUNTIME_PROVIDER §7。
 *
 * 输入只有 core 事实（CollectableMetrics，与 §4.4 RoundMetrics 同构；orchestrator 落地后转交）：
 * 性能/经济滚动画像、样本守卫与降级链（§7.3）。synthetic（faux）数据不入画像（§9.3）。
 * 画像只产出统计与样本量；"样本不足是否可用"由路由侧读取 sampleSize 自行降权（本层不隐藏填充）。
 * qualitySource 为 P2 占位（§7.3.4 / 开放问题 #2）：未接线时 qualitySampleSize=0、
 * costPerQualityScore 无数据（undefined）。
 */

import type { TokenUsage } from '@mazi/core';

export interface Percentile {
    p50: number;
    p90: number;
    p95: number;
    p99?: number;
}

export interface PerformanceProfile {
    /** outputTokens / (totalMs − ttftMs) */
    tokensPerSecond: Percentile;
    ttftMs: Percentile;
    e2eLatencyMs: Percentile;
    /** 失败占比（§6.1 countsAsError 口径，见本文件 record） */
    errorRate: number;
    toolCallSchemaCompliance: number;
    sampleSize: number;
    /** 默认 3_600_000 */
    windowMs: number;
    lastUpdated: number;
}

export interface TagEconomics {
    avgTokensPerTurn: { input: number; output: number };
    avgTaskCostUsd: number;
    successRate: number;
    /** < 30 时该 tag 维度回退到模型整体画像 */
    sampleSize: number;
}

export interface EconomicsProfile {
    avgTaskCostUsd: number;
    avgTokensPerTurn: { input: number; output: number };
    /** qualitySampleSize === 0 时无数据（undefined），路由降级（§7.3） */
    costPerQualityScore?: number;
    qualitySampleSize: number;
    retryRate: number;
    sampleSize: number;
    perTag?: Partial<Record<string, TagEconomics>>;
    lastUpdated: number;
}

export interface QualitySample {
    score: number;
    at: number;
    source: 'user-feedback' | 'judge';
}

/** P2 占位（§7.3.4）：质量信号源，未接线前不产出 costPerQualityScore。 */
export interface QualitySignalSource {
    sample(modelId: string): Promise<QualitySample | null>;
}

/** Collector 入参（与 §4.4 RoundMetrics 同构的最小事实面）。 */
export interface CollectableMetrics {
    providerId: string;
    modelId: string;
    ok: boolean;
    usage?: TokenUsage;
    ttftMs?: number;
    totalMs: number;
    errorCode?: string;
    abortedBy?: 'caller' | 'timeout' | null;
    costUsd?: number;
    attempts?: number;
    tags?: string[];
    /** faux 轮次：不入画像（§9.3） */
    synthetic?: boolean;
    at: number;
}

export interface ProfileSnapshot {
    models: Record<string, { performance: PerformanceProfile; economics: EconomicsProfile }>;
    savedAt: number;
}

interface LatencySamples {
    tps: number[];
    ttft: number[];
    e2e: number[];
    at: number[];
}
interface EconSamples {
    cost: number[];
    input: number[];
    output: number[];
    at: number[];
    attempts: number[];
    ok: boolean[];
    tags: string[][];
}
interface ModelRecord {
    key: string;
    perf: LatencySamples;
    econ: EconSamples;
    errorCount: number;
    lastUpdated: number;
}

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[Math.max(0, idx)];
}

export interface ProfileCollectorOptions {
    windowMs?: number;
    now?: () => number;
}

const DEFAULT_WINDOW_MS = 3_600_000;

export class ProfileCollector {
    private readonly records = new Map<string, ModelRecord>();
    private readonly opts: { windowMs: number; now: () => number };

    constructor(options: ProfileCollectorOptions = {}) {
        this.opts = {
            windowMs: options.windowMs ?? DEFAULT_WINDOW_MS,
            now: options.now ?? Date.now,
        };
    }

    record(metrics: CollectableMetrics): void {
        if (metrics.synthetic === true) return;
        const key = `${metrics.providerId}/${metrics.modelId}`;
        const rec = this.records.get(key) ?? {
            key,
            perf: { tps: [], ttft: [], e2e: [], at: [] },
            econ: { cost: [], input: [], output: [], at: [], attempts: [], ok: [], tags: [] },
            errorCount: 0,
            lastUpdated: 0,
        };
        this.purgeExpired(rec, metrics.at);
        const at = metrics.at;
        rec.lastUpdated = Math.max(rec.lastUpdated, at);
        const tps =
            metrics.totalMs > (metrics.ttftMs ?? 0) && metrics.usage?.outputTokens
                ? (metrics.usage.outputTokens / (metrics.totalMs - (metrics.ttftMs ?? 0))) * 1000
                : undefined;
        if (tps !== undefined) rec.perf.tps.push(tps);
        if (metrics.ttftMs !== undefined) rec.perf.ttft.push(metrics.ttftMs);
        rec.perf.e2e.push(metrics.totalMs);
        rec.perf.at.push(at);
        rec.econ.cost.push(metrics.costUsd ?? 0);
        rec.econ.input.push(metrics.usage?.inputTokens ?? 0);
        rec.econ.output.push(metrics.usage?.outputTokens ?? 0);
        rec.econ.attempts.push(metrics.attempts ?? 1);
        rec.econ.ok.push(metrics.ok);
        rec.econ.tags.push(metrics.tags ?? []);
        rec.econ.at.push(at);
        // 错误口径（§6.1 countsAsError 近似）：caller 取消 / invalid_request 不算
        const ignorable = metrics.abortedBy === 'caller' || metrics.errorCode === 'invalid_request';
        if (!metrics.ok && !ignorable) rec.errorCount += 1;
        this.records.set(key, rec);
    }

    private purgeExpired(rec: ModelRecord, now: number): void {
        const cutoff = now - this.opts.windowMs;
        const keepP = rec.perf.at.map((at, i) => (at >= cutoff ? i : -1)).filter((i) => i >= 0);
        const p = rec.perf;
        rec.perf = {
            tps: keepP.map((i) => p.tps[i]).filter((v): v is number => v !== undefined),
            ttft: keepP.map((i) => p.ttft[i]).filter((v): v is number => v !== undefined),
            e2e: keepP.map((i) => p.e2e[i]).filter((v): v is number => v !== undefined),
            at: keepP.map((i) => p.at[i]).filter((v): v is number => v !== undefined),
        };
        const e = rec.econ;
        const keepE = e.at.map((at, i) => (at >= cutoff ? i : -1)).filter((i) => i >= 0);
        rec.econ = {
            cost: keepE.map((i) => e.cost[i]).filter((v): v is number => v !== undefined),
            input: keepE.map((i) => e.input[i]).filter((v): v is number => v !== undefined),
            output: keepE.map((i) => e.output[i]).filter((v): v is number => v !== undefined),
            at: keepE.map((i) => e.at[i]).filter((v): v is number => v !== undefined),
            attempts: keepE.map((i) => e.attempts[i]).filter((v): v is number => v !== undefined),
            ok: keepE.map((i) => e.ok[i]).filter((v): v is boolean => v !== undefined),
            tags: keepE.map((i) => e.tags[i]).filter((v): v is string[] => v !== undefined),
        };
    }

    private recordOf(providerId: string, modelId: string): ModelRecord | undefined {
        return this.records.get(`${providerId}/${modelId}`);
    }

    performance(providerId: string, modelId: string): PerformanceProfile | null {
        const rec = this.recordOf(providerId, modelId);
        if (!rec || rec.perf.e2e.length === 0) return null;
        const tps = [...rec.perf.tps].sort((a, b) => a - b);
        const ttft = [...rec.perf.ttft].sort((a, b) => a - b);
        const e2e = [...rec.perf.e2e].sort((a, b) => a - b);
        return {
            tokensPerSecond: {
                p50: percentile(tps, 50),
                p90: percentile(tps, 90),
                p95: percentile(tps, 95),
            },
            ttftMs: {
                p50: percentile(ttft, 50),
                p90: percentile(ttft, 90),
                p95: percentile(ttft, 95),
            },
            e2eLatencyMs: {
                p50: percentile(e2e, 50),
                p90: percentile(e2e, 90),
                p95: percentile(e2e, 95),
            },
            errorRate: rec.econ.ok.length > 0 ? rec.errorCount / rec.econ.ok.length : 0,
            toolCallSchemaCompliance: 0, // P2：质量源未接线（开放问题 #2）
            sampleSize: rec.econ.ok.length,
            windowMs: this.opts.windowMs,
            lastUpdated: rec.lastUpdated,
        };
    }

    economics(providerId: string, modelId: string): EconomicsProfile | null {
        const rec = this.recordOf(providerId, modelId);
        if (!rec || rec.econ.ok.length === 0) return null;
        const n = rec.econ.ok.length;
        const sumCost = rec.econ.cost.reduce((a, b) => a + b, 0);
        const sumIn = rec.econ.input.reduce((a, b) => a + b, 0);
        const sumOut = rec.econ.output.reduce((a, b) => a + b, 0);
        const success = rec.econ.ok.filter((v) => v).length;
        const retried = rec.econ.attempts.filter((v) => v > 1).length;
        const perTag: Partial<Record<string, TagEconomics>> = {};
        const tagIndex = new Map<string, number[]>();
        rec.econ.tags.forEach((tags, i) => {
            for (const tag of tags) {
                const list = tagIndex.get(tag) ?? [];
                list.push(i);
                tagIndex.set(tag, list);
            }
        });
        for (const [tag, idxs] of tagIndex) {
            const samples = idxs;
            const successInTag = samples.filter((i) => rec.econ.ok[i]).length;
            perTag[tag] = {
                avgTokensPerTurn: {
                    input:
                        samples.reduce((a, i) => a + (rec.econ.input[i] ?? 0), 0) / samples.length,
                    output:
                        samples.reduce((a, i) => a + (rec.econ.output[i] ?? 0), 0) / samples.length,
                },
                avgTaskCostUsd:
                    samples.reduce((a, i) => a + (rec.econ.cost[i] ?? 0), 0) / samples.length,
                successRate: successInTag / samples.length,
                sampleSize: samples.length,
            };
        }
        return {
            avgTaskCostUsd: sumCost / n,
            avgTokensPerTurn: { input: sumIn / n, output: sumOut / n },
            costPerQualityScore: undefined, // qualitySource P2 占位
            qualitySampleSize: 0,
            retryRate: retried / n,
            sampleSize: n,
            ...(Object.keys(perTag).length > 0 ? { perTag } : {}),
            lastUpdated: rec.lastUpdated,
        };
    }

    snapshot(): ProfileSnapshot {
        const models: ProfileSnapshot['models'] = {};
        for (const rec of this.records.values()) {
            const [providerId, modelId] = rec.key.split('/');
            if (!providerId || !modelId) continue;
            const performance = this.performance(providerId, modelId);
            const economics = this.economics(providerId, modelId);
            if (performance && economics) {
                models[rec.key] = { performance, economics };
            }
        }
        return { models, savedAt: this.opts.now() };
    }
}
