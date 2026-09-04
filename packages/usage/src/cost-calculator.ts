import type { CostBreakdown, PricingSchedule, VendorUsage } from '@mazi/core';

const TOKENS_PER_MILLION = 1_000_000;

/**
 * 成本计算器：按 pricing.base 基础单价计费。
 * MVP v1.0 §5.2：tier 不生效，priceTierApplied 恒为 'base'，pricingVersion 记录定价版本（验收 A6）。
 */
export class CostCalculator {
    /**
     * 计算一次 vendor 调用的成本拆分。
     * cacheWrite/cacheRead/reasoning 仅当 base 有对应费率且厂商上报了计数时才计费，否则为 0。
     */
    calculate(pricing: PricingSchedule, vendor: VendorUsage): CostBreakdown {
        const base = pricing.base;

        const inputCostUsd = (vendor.inputTokens / TOKENS_PER_MILLION) * base.inputPerMTok;
        const outputCostUsd = (vendor.outputTokens / TOKENS_PER_MILLION) * base.outputPerMTok;
        const cacheWriteCostUsd = this.billOptional(
            base.cacheWritePerMTok,
            vendor.cacheCreationInputTokens,
        );
        const cacheReadCostUsd = this.billOptional(
            base.cacheReadPerMTok,
            vendor.cacheReadInputTokens,
        );
        const reasoningCostUsd = this.billOptional(
            base.reasoningPerMTok,
            vendor.reasoningOutputTokens,
        );

        return {
            inputCostUsd,
            outputCostUsd,
            cacheWriteCostUsd,
            cacheReadCostUsd,
            reasoningCostUsd,
            totalCostUsd:
                inputCostUsd +
                outputCostUsd +
                cacheWriteCostUsd +
                cacheReadCostUsd +
                reasoningCostUsd,
            priceTierApplied: 'base',
            pricingVersion: pricing.version,
            currency: pricing.currency,
            calculatedAt: Date.now(),
        };
    }

    /** 有费率且计数 > 0 时按 base 单价计费，否则不计（0） */
    private billOptional(ratePerMTok: number | undefined, count: number | undefined): number {
        if (ratePerMTok === undefined || count === undefined || count <= 0) {
            return 0;
        }
        return (count / TOKENS_PER_MILLION) * ratePerMTok;
    }
}
