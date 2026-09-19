import { describe, expect, it } from 'vitest';

import type { RuntimeContextBreakdown } from '@mazi/core';

import {
    DEFAULT_ESTIMATED_CACHED_RATIO,
    nextEstimatedCachedRatio,
    roundEstimatedCost,
} from '../src/harness/round-accounting.js';
import type { PricingSchedule } from '../src/provider/pricing.js';

const pricing: PricingSchedule = {
    currency: 'USD',
    base: { inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.5 },
    tiers: [],
    effectiveAt: 0,
    version: 'test',
};

const ctx = (totalContextTokens: number): RuntimeContextBreakdown =>
    ({ totalContextTokens }) as unknown as RuntimeContextBreakdown;

describe('roundEstimatedCost', () => {
    it('IN 按 vendor 缓存命中率拆 cached + miss；OUT 按 out_price', () => {
        const breakdown = roundEstimatedCost(ctx(1000), { outputTokens: 100 }, pricing, 0.5);
        // 500 cached @ 0.5/MTok + 500 miss @ 2/MTok = 0.00025 + 0.001
        expect(breakdown.cacheReadCostUsd).toBeCloseTo((500 / 1_000_000) * 0.5, 12);
        expect(breakdown.inputCostUsd).toBeCloseTo((500 / 1_000_000) * 2, 12);
        expect(breakdown.outputCostUsd).toBeCloseTo((100 / 1_000_000) * 8, 12);
        expect(breakdown.totalCostUsd).toBeCloseTo(0.00125 + 0.0008, 12);
    });

    it('缺省无命中率 → 全部按 miss 计', () => {
        const breakdown = roundEstimatedCost(ctx(1000), { outputTokens: 0 }, pricing);
        expect(breakdown.cacheReadCostUsd).toBe(0);
        expect(breakdown.inputCostUsd).toBeCloseTo((1000 / 1_000_000) * 2, 12);
    });
});

describe('nextEstimatedCachedRatio', () => {
    it('vendor 未上报 → 沿用当前值；初始为 0.8', () => {
        expect(DEFAULT_ESTIMATED_CACHED_RATIO).toBe(0.9);
        expect(nextEstimatedCachedRatio(DEFAULT_ESTIMATED_CACHED_RATIO, undefined, 30)).toBe(0.9);
        expect(nextEstimatedCachedRatio(0.9, undefined, undefined)).toBe(0.9);
        expect(nextEstimatedCachedRatio(0.9, 15, 0)).toBe(0.9);
    });

    it('vendor 上报 cacheRead/input → 更新并 clamp 到 [0,1]', () => {
        expect(nextEstimatedCachedRatio(0.8, 15, 30)).toBe(0.5);
        expect(nextEstimatedCachedRatio(0.8, 0, 30)).toBe(0);
        expect(nextEstimatedCachedRatio(0.8, 60, 30)).toBe(1);
    });
});
