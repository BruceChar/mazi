/**
 * Pricer —— 实现 AHF_RUNTIME_PROVIDER §5。
 *
 * 基于 [CORE §8] 全量口径 usage 派生各计费成分并计算成本：
 *   CR = cachedInputTokens ?? 0（⊆ inputTokens）
 *   R  = reasoningTokens ?? 0   （⊆ outputTokens）
 *   units['input']      = inputTokens − CR
 *   units['cache-read'] = CR
 *   units['cache-write'] = 0（core usage 未暴露独立写入量，见开放问题 #4）
 *   reasoning 单价已定义 → output − R / reasoning = R（拆分语义）
 *   否则                     → output 全部 / reasoning = 0（并入语义，不双计）
 * cost = Σ_component tierMultiplier(hourUtc, component) × unitPrice × units / 1e6
 * 未报告字段按 0；unitPrice 缺失的成分按 0（不产生成本）。
 * BillingLedger：进程内累计账本（§5.4 本期形态），供经济画像与账单展示。
 */

import type { CostBreakdown, TokenUsage } from '@mazi/core';

export type CostComponent = 'input' | 'output' | 'cache-write' | 'cache-read' | 'reasoning';

export interface PricingSchedule {
    currency: 'USD';
    base: {
        inputPerMTok: number;
        outputPerMTok: number;
        cacheWritePerMTok?: number;
        cacheReadPerMTok?: number;
        reasoningPerMTok?: number;
    };
    tiers: PricingTier[];
    effectiveAt: number;
    version: string;
}

export interface PricingTier {
    name: string;
    /** UTC 小时，半开区间 [start, end)；start > end 表示跨午夜（如 [22,6)） */
    windowHoursUtc: [number, number];
    /** > 0；0.5 = 半价 */
    multiplier: number;
    /** 缺省 = 作用于全部成分 */
    appliesTo?: CostComponent[];
}

const ALL_COMPONENTS: readonly CostComponent[] = [
    'input',
    'output',
    'cache-read',
    'cache-write',
    'reasoning',
];

export type ComponentUnits = Record<CostComponent, number>;

/** 从全量口径 usage 派生计费成分（§5.2；拆分/并入语义由单价表决定）。 */
export function deriveComponentUnits(usage: TokenUsage, pricing: PricingSchedule): ComponentUnits {
    const cr = usage.cachedInputTokens ?? 0;
    const cw = usage.cachedWriteInputTokens ?? 0;
    const reasoning = usage.reasoningTokens ?? 0;
    const units: ComponentUnits = {
        input: Math.max((usage.inputTokens ?? 0) - cr - cw, 0),
        output: usage.outputTokens ?? 0,
        'cache-read': cr,
        'cache-write': cw,
        reasoning: 0,
    };
    if (pricing.base.reasoningPerMTok !== undefined) {
        units.output = Math.max(units.output - reasoning, 0);
        units.reasoning = reasoning;
    }
    return units;
}

/** 单位价格（$/MTok）；base 未声明该成分 → undefined（按 0 计）。 */
export function unitPricePerMTok(
    pricing: PricingSchedule,
    component: CostComponent,
): number | undefined {
    switch (component) {
        case 'input':
            return pricing.base.inputPerMTok;
        case 'output':
            return pricing.base.outputPerMTok;
        case 'cache-write':
            return pricing.base.cacheWritePerMTok;
        case 'cache-read':
            return pricing.base.cacheReadPerMTok;
        case 'reasoning':
            return pricing.base.reasoningPerMTok;
    }
}

/** 成分单价按 US$/token 换算：PerMTok / 1e6。 */
export function unitPricePerToken(pricing: PricingSchedule, component: CostComponent): number {
    return (unitPricePerMTok(pricing, component) ?? 0) / 1_000_000;
}

/**
 * 档位倍率（§5.3）：对每个成分独立扫描 tiers，取第一个「窗口命中 且 appliesTo 覆盖该
 * 成分（或缺省）」的档位；无命中 → 1.0（base）。
 * 跨午夜判定：start > end 时 h ∈ [start, 24) ∪ [0, end)；否则 start ≤ h < end。
 */
export function tierMultiplier(
    pricing: PricingSchedule,
    hourUtc: number,
    component: CostComponent,
): number {
    for (const tier of pricing.tiers) {
        const [start, end] = tier.windowHoursUtc;
        const inWindow =
            start > end ? hourUtc >= start || hourUtc < end : hourUtc >= start && hourUtc < end;
        if (!inWindow) continue;
        if (tier.appliesTo === undefined || tier.appliesTo.includes(component)) {
            return tier.multiplier;
        }
    }
    return 1;
}

/** 命中的档位名：第一个窗口命中的 tier；无命中回落 base。 */
function appliedTierName(pricing: PricingSchedule, hourUtc: number): string {
    for (const tier of pricing.tiers) {
        const [start, end] = tier.windowHoursUtc;
        const inWindow =
            start > end ? hourUtc >= start || hourUtc < end : hourUtc >= start && hourUtc < end;
        if (inWindow) {
            return tier.name;
        }
    }
    return 'base';
}

/** 计算一次调用的成本拆分（USD）。now 缺省取当前时间；小时取 UTC。 */
export function computeCostBreakdown(
    usage: TokenUsage,
    pricing: PricingSchedule,
    now: Date = new Date(),
): CostBreakdown {
    const units = deriveComponentUnits(usage, pricing);
    const hourUtc = now.getUTCHours();
    const costOf = (component: CostComponent): number =>
        tierMultiplier(pricing, hourUtc, component) *
        unitPricePerToken(pricing, component) *
        units[component];
    const costs: Record<CostComponent, number> = {
        input: costOf('input'),
        output: costOf('output'),
        'cache-read': costOf('cache-read'),
        'cache-write': costOf('cache-write'),
        reasoning: costOf('reasoning'),
    };
    let totalCostUsd = 0;
    for (const component of ALL_COMPONENTS) {
        totalCostUsd += costs[component];
    }
    return {
        inputCostUsd: costs.input,
        outputCostUsd: costs.output,
        cacheWriteCostUsd: costs['cache-write'],
        cacheReadCostUsd: costs['cache-read'],
        reasoningCostUsd: costs.reasoning,
        totalCostUsd,
        priceTierApplied: appliedTierName(pricing, hourUtc),
        pricingVersion: pricing.version,
        currency: 'USD',
        calculatedAt: now.getTime(),
    };
}

/** 计算一次调用成本（USD）。now 缺省取当前时间；小时取 UTC。 */
export function computeCostUsd(
    usage: TokenUsage,
    pricing: PricingSchedule,
    now: Date = new Date(),
): number {
    return computeCostBreakdown(usage, pricing, now).totalCostUsd;
}

// ------------------------------------------------------------
// BillingLedger（§5.4：进程内累计，不做对账）
// ------------------------------------------------------------

export interface LedgerLine {
    providerId: string;
    modelId: string;
    /** §5.2 派生结果 */
    costUsd: number;
    usage?: TokenUsage;
    at: number;
}

export interface LedgerTotals {
    costUsd: number;
    /** Σ usage.totalTokens；usage 缺失的条目不计入 */
    totalTokens: number;
    lines: number;
}

/** 进程内累计账本：仅追加，不做对账（对账/配额属开放问题 #6）。 */
export class BillingLedger {
    private readonly lines: LedgerLine[] = [];

    record(line: LedgerLine): void {
        this.lines.push(line);
    }

    list(): readonly LedgerLine[] {
        return this.lines;
    }

    totals(): LedgerTotals {
        let costUsd = 0;
        let totalTokens = 0;
        for (const line of this.lines) {
            costUsd += line.costUsd;
            if (line.usage?.totalTokens !== undefined) {
                totalTokens += line.usage.totalTokens;
            }
        }
        return { costUsd, totalTokens, lines: this.lines.length };
    }
}
