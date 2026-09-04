import type { PricingSchedule, VendorUsage } from '@mazi/core';
import { describe, expect, it } from 'vitest';
import { CostCalculator } from './cost-calculator';

/** 测试夹具：完整基础费率（可按需整体覆盖 base/tiers/version） */
function makePricing(overrides: Partial<PricingSchedule> = {}): PricingSchedule {
    return {
        currency: 'USD',
        base: {
            inputPerMTok: 3,
            outputPerMTok: 12,
            cacheWritePerMTok: 4,
            cacheReadPerMTok: 0.5,
            reasoningPerMTok: 6,
        },
        tiers: [],
        effectiveAt: 0,
        version: '2024-09-v1',
        ...overrides,
    };
}

describe('usage 计价 CostCalculator（MVP v1.0 §5.2 / §8 F6）', () => {
    it('按 base 单价计 input/output 及 cache/reasoning', () => {
        const vendor: VendorUsage = {
            inputTokens: 2_000_000,
            outputTokens: 1_000_000,
            cacheCreationInputTokens: 500_000,
            cacheReadInputTokens: 2_000_000,
            reasoningOutputTokens: 1_000_000,
            reportedByVendor: true,
        };
        const before = Date.now();
        const cost = new CostCalculator().calculate(makePricing(), vendor);
        expect(cost.inputCostUsd).toBe(6); // 2M/1M × 3
        expect(cost.outputCostUsd).toBe(12); // 1M/1M × 12
        expect(cost.cacheWriteCostUsd).toBe(2); // 0.5M/1M × 4
        expect(cost.cacheReadCostUsd).toBe(1); // 2M/1M × 0.5
        expect(cost.reasoningCostUsd).toBe(6); // 1M/1M × 6
        expect(cost.totalCostUsd).toBe(27);
        expect(cost.priceTierApplied).toBe('base');
        expect(cost.pricingVersion).toBe('2024-09-v1');
        expect(cost.currency).toBe('USD');
        expect(cost.calculatedAt).toBeGreaterThanOrEqual(before);
        expect(cost.calculatedAt).toBeLessThanOrEqual(Date.now());
    });

    it('tier 不生效：存在高倍率档位仍按 base 计（验收 A6）', () => {
        const peakSchedule = makePricing({
            tiers: [{ name: 'peak', windowHoursUtc: [0, 24], multiplier: 2, appliesTo: ['input'] }],
        });
        const cost = new CostCalculator().calculate(peakSchedule, {
            inputTokens: 1_000_000,
            outputTokens: 0,
            reportedByVendor: true,
        });
        expect(cost.inputCostUsd).toBe(3); // 未乘档位倍率 2
        expect(cost.priceTierApplied).toBe('base');
        expect(cost.pricingVersion).toBe('2024-09-v1');
    });

    it('厂商上报 cache/reasoning 计数但 base 无对应费率 → 该分类成本为 0', () => {
        const noExtraRates = makePricing({
            base: { inputPerMTok: 3, outputPerMTok: 4 },
        });
        const vendor: VendorUsage = {
            inputTokens: 1_000_000,
            outputTokens: 1_000_000,
            cacheCreationInputTokens: 1_000_000,
            cacheReadInputTokens: 1_000_000,
            reasoningOutputTokens: 1_000_000,
            reportedByVendor: true,
        };
        const cost = new CostCalculator().calculate(noExtraRates, vendor);
        expect(cost.cacheWriteCostUsd).toBe(0);
        expect(cost.cacheReadCostUsd).toBe(0);
        expect(cost.reasoningCostUsd).toBe(0);
        expect(cost.totalCostUsd).toBe(7); // 仅 input(3) + output(4)
    });

    it('有费率但厂商未上报对应计数（undefined）→ 该分类成本为 0', () => {
        const vendor: VendorUsage = {
            inputTokens: 1_000_000,
            outputTokens: 1_000_000,
            reportedByVendor: true,
        };
        const cost = new CostCalculator().calculate(makePricing(), vendor);
        expect(cost.cacheWriteCostUsd).toBe(0);
        expect(cost.cacheReadCostUsd).toBe(0);
        expect(cost.reasoningCostUsd).toBe(0);
        expect(cost.totalCostUsd).toBe(15); // input(3) + output(12)
    });
});
