/**
 * catalog/ledger —— 账本域纯函数：派发钉死 → 凭证构造 → 审计聚合。
 * 账本 append-only：凭证一旦落库，价格修正只影响未来请求。
 */

import type { DispatchPin, Offering, PricingPlan, UsageRecord, UsageTokens } from '@mazi/core';
import { priceUsage } from '@mazi/core';

export interface BuildUsageRecordInput {
    id: string;
    pin: DispatchPin;
    offering: Offering;
    plan: PricingPlan;
    tokens: UsageTokens;
    occurredAt: number;
}

/** 由钉死的价格计划计算成本并生成不可变凭证（冗余 model/provider/cost 便于审计与报表）。 */
export function buildUsageRecord(input: BuildUsageRecordInput): UsageRecord {
    const cost = priceUsage(input.tokens, input.plan);
    return {
        id: input.id,
        offeringId: input.offering.id,
        modelId: input.offering.modelId,
        providerId: input.offering.providerId,
        pricingPlanId: input.pin.pricingPlanId,
        catalogEpoch: input.pin.catalogEpoch,
        inputTokens: input.tokens.inputTokens,
        outputTokens: input.tokens.outputTokens,
        cacheReadTokens: input.tokens.cacheReadTokens ?? 0,
        cacheWriteTokens: input.tokens.cacheWriteTokens ?? 0,
        cost: cost.totalCostUsd,
        currency: cost.currency,
        occurredAt: input.occurredAt,
    };
}

export interface UsageFilter {
    offeringId?: string;
    modelId?: string;
    providerId?: string;
    catalogEpoch?: number;
    /** [from, to) epoch ms */
    from?: number;
    to?: number;
}

export function filterUsage(
    records: readonly UsageRecord[],
    filter: UsageFilter = {},
): UsageRecord[] {
    return records.filter((record) => {
        if (filter.offeringId !== undefined && record.offeringId !== filter.offeringId)
            return false;
        if (filter.modelId !== undefined && record.modelId !== filter.modelId) return false;
        if (filter.providerId !== undefined && record.providerId !== filter.providerId)
            return false;
        if (filter.catalogEpoch !== undefined && record.catalogEpoch !== filter.catalogEpoch)
            return false;
        if (filter.from !== undefined && record.occurredAt < filter.from) return false;
        if (filter.to !== undefined && record.occurredAt >= filter.to) return false;
        return true;
    });
}

export interface UsageTotals {
    records: number;
    cost: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    currency: string;
}

export function usageTotals(records: readonly UsageRecord[]): UsageTotals {
    const totals: UsageTotals = {
        records: records.length,
        cost: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        currency: 'USD',
    };
    for (const record of records) {
        totals.cost += record.cost;
        totals.inputTokens += record.inputTokens;
        totals.outputTokens += record.outputTokens;
        totals.cacheReadTokens += record.cacheReadTokens;
        totals.cacheWriteTokens += record.cacheWriteTokens;
        if (record.currency) totals.currency = record.currency;
    }
    return totals;
}

export type UsageGroupKey = 'offeringId' | 'modelId' | 'providerId' | 'catalogEpoch';

export interface UsageGroup {
    key: string | number;
    totals: UsageTotals;
}

/** 按指定维度聚合（报表用；账本明细仍是唯一权威）。 */
export function groupUsageBy(records: readonly UsageRecord[], key: UsageGroupKey): UsageGroup[] {
    const groups = new Map<string | number, UsageRecord[]>();
    for (const record of records) {
        const groupKey = record[key];
        const bucket = groups.get(groupKey);
        if (bucket === undefined) groups.set(groupKey, [record]);
        else bucket.push(record);
    }
    return [...groups.entries()]
        .map(([groupKey, bucket]) => ({ key: groupKey, totals: usageTotals(bucket) }))
        .sort((a, b) => String(a.key).localeCompare(String(b.key)));
}
