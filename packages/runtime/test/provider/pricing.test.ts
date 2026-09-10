import type { TokenUsage } from '@mazi/core';
import { describe, expect, it } from 'vitest';
import type { PricingSchedule } from '../../src/provider/pricing.js';
import {
    BillingLedger,
    computeCostBreakdown,
    computeCostUsd,
    deriveComponentUnits,
    tierMultiplier,
} from '../../src/provider/pricing.js';

function baseSchedule(over: Partial<PricingSchedule['base']> = {}): PricingSchedule {
    return {
        currency: 'USD',
        base: { inputPerMTok: 2.5, outputPerMTok: 10, ...over },
        tiers: [],
        effectiveAt: 0,
        version: 'test',
    };
}

function usage(over: Partial<TokenUsage> = {}): TokenUsage {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0, ...over };
}

describe('Pricer（AHF_RUNTIME_PROVIDER §5）', () => {
    it('基础成本：input/output × 单价 / 1e6，无档位回落 base', () => {
        const cost = computeCostUsd(
            usage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }),
            baseSchedule(),
            new Date('2026-01-01T12:00:00Z'),
        );
        expect(cost).toBeCloseTo((1000 * 2.5 + 500 * 10) / 1e6, 10);
    });

    it('缓存子集：inputTokens − cachedInputTokens 派生 input，cachedRead 走缓存单价', () => {
        const schedule = baseSchedule({ inputPerMTok: 3, cacheReadPerMTok: 1, outputPerMTok: 15 });
        const cost = computeCostUsd(
            usage({
                inputTokens: 1000,
                cachedInputTokens: 200,
                outputTokens: 300,
                totalTokens: 1300,
            }),
            schedule,
            new Date('2026-01-01T12:00:00Z'),
        );
        expect(cost).toBeCloseTo((800 * 3 + 200 * 1 + 300 * 15) / 1e6, 10);
    });

    it('reasoning 拆分语义：声明 reasoningPerMTok 时 output − R、reasoning = R', () => {
        const schedule = baseSchedule({ outputPerMTok: 20, reasoningPerMTok: 5 });
        const units = deriveComponentUnits(
            usage({ inputTokens: 0, outputTokens: 100, reasoningTokens: 40, totalTokens: 100 }),
            schedule,
        );
        expect(units.output).toBe(60);
        expect(units.reasoning).toBe(40);
        const cost = computeCostUsd(
            usage({ inputTokens: 0, outputTokens: 100, reasoningTokens: 40, totalTokens: 100 }),
            schedule,
            new Date('2026-01-01T12:00:00Z'),
        );
        expect(cost).toBeCloseTo((60 * 20 + 40 * 5) / 1e6, 10);
    });

    it('reasoning 并入语义：未声明 reasoningPerMTok 时不双计', () => {
        const schedule = baseSchedule({ outputPerMTok: 20 });
        const units = deriveComponentUnits(
            usage({ inputTokens: 0, outputTokens: 100, reasoningTokens: 40, totalTokens: 100 }),
            schedule,
        );
        expect(units.output).toBe(100);
        expect(units.reasoning).toBe(0);
    });

    it('档位按成分独立匹配：跨午夜窗口只作用于声明成分', () => {
        const schedule = baseSchedule({ inputPerMTok: 2, outputPerMTok: 10 });
        schedule.tiers.push({
            name: 'night-input',
            windowHoursUtc: [22, 6],
            multiplier: 0.5,
            appliesTo: ['input'],
        });
        // 23 点：input 半价，output 原价
        expect(tierMultiplier(schedule, 23, 'input')).toBe(0.5);
        expect(tierMultiplier(schedule, 23, 'output')).toBe(1);
        // 5 点仍属跨午夜窗口；6 点不在（半开）
        expect(tierMultiplier(schedule, 5, 'input')).toBe(0.5);
        expect(tierMultiplier(schedule, 6, 'input')).toBe(1);
        // 12 点回落 base
        expect(tierMultiplier(schedule, 12, 'input')).toBe(1);
    });

    it('未报告字段按 0；cache-write 恒为 0（开放问题 #4）', () => {
        const units = deriveComponentUnits(
            usage({ outputTokens: 5, totalTokens: 5 }),
            baseSchedule(),
        );
        expect(units.input).toBe(0);
        expect(units['cache-write']).toBe(0);
    });

    it('computeCostBreakdown：成分拆分与总额一致，档位名回落 base', () => {
        const schedule = baseSchedule({ inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 1 });
        const breakdown = computeCostBreakdown(
            usage({
                inputTokens: 1000,
                cachedInputTokens: 200,
                outputTokens: 300,
                totalTokens: 1300,
            }),
            schedule,
            new Date('2026-01-01T12:00:00Z'),
        );
        expect(breakdown.inputCostUsd).toBeCloseTo((800 * 2) / 1e6, 12);
        expect(breakdown.cacheReadCostUsd).toBeCloseTo((200 * 1) / 1e6, 12);
        expect(breakdown.outputCostUsd).toBeCloseTo((300 * 10) / 1e6, 12);
        expect(breakdown.cacheWriteCostUsd).toBe(0);
        expect(breakdown.reasoningCostUsd).toBe(0);
        expect(breakdown.totalCostUsd).toBeCloseTo(
            breakdown.inputCostUsd +
                breakdown.outputCostUsd +
                breakdown.cacheWriteCostUsd +
                breakdown.cacheReadCostUsd +
                breakdown.reasoningCostUsd,
            12,
        );
        expect(breakdown.priceTierApplied).toBe('base');
        expect(breakdown.currency).toBe('USD');
    });

    it('computeCostBreakdown：命中档位名写入 priceTierApplied，且与 computeCostUsd 一致', () => {
        const schedule = baseSchedule();
        schedule.tiers.push({ name: 'off-peak', windowHoursUtc: [0, 24], multiplier: 0.5 });
        const at = new Date('2026-01-01T12:00:00Z');
        const payload = usage({ inputTokens: 100, outputTokens: 0, totalTokens: 100 });
        const breakdown = computeCostBreakdown(payload, schedule, at);
        expect(breakdown.priceTierApplied).toBe('off-peak');
        expect(computeCostUsd(payload, schedule, at)).toBeCloseTo(breakdown.totalCostUsd, 12);
    });

    it('BillingLedger：进程内累计', () => {
        const ledger = new BillingLedger();
        ledger.record({
            providerId: 'p1',
            modelId: 'm1',
            costUsd: 0.001,
            usage: usage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
            at: 1,
        });
        ledger.record({ providerId: 'p1', modelId: 'm1', costUsd: 0.002, at: 2 });
        const totals = ledger.totals();
        expect(totals.costUsd).toBeCloseTo(0.003, 10);
        expect(totals.totalTokens).toBe(15);
        expect(totals.lines).toBe(2);
    });
});
