import { describe, expect, it } from 'vitest';
import type { UsageRecordView } from '../src/cost-ledger.js';
import { groupUsageByHour, hourStartOf, sumUsage } from '../src/cost-ledger.js';

function record(over: Partial<UsageRecordView> & Pick<UsageRecordView, 'occurredAt'>): UsageRecordView {
    return {
        id: 'r',
        offeringId: 'deepseek/deepseek-chat',
        modelId: 'deepseek-chat',
        providerId: 'deepseek',
        pricingPlanId: 'p',
        catalogEpoch: 1,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheWriteTokens: 0,
        cost: 0.001,
        currency: 'USD',
        ...over,
    };
}

describe('cost-ledger（花费账本小时聚合）', () => {
    it('hourStartOf：本地整点清零', () => {
        const ts = new Date(2026, 8, 19, 13, 47, 22, 500).getTime();
        const start = hourStartOf(ts);
        const date = new Date(start);
        expect([date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()]).toEqual([
            13, 0, 0, 0,
        ]);
    });

    it('groupUsageByHour：同小时合并、跨小时分桶、按 hourStart 降序', () => {
        const t0 = new Date(2026, 8, 19, 10, 5, 0).getTime();
        const t1 = new Date(2026, 8, 19, 10, 55, 0).getTime();
        const t2 = new Date(2026, 8, 19, 11, 1, 0).getTime();
        const buckets = groupUsageByHour([
            record({ occurredAt: t0, cost: 0.001 }),
            record({ occurredAt: t1, cost: 0.002, inputTokens: 1, outputTokens: 2 }),
            record({ occurredAt: t2, cost: 0.01 }),
        ]);
        expect(buckets).toHaveLength(2);
        expect(buckets[0]?.label).toMatch(/11:00$/);
        expect(buckets[0]?.cost).toBeCloseTo(0.01, 12);
        expect(buckets[1]?.calls).toBe(2);
        expect(buckets[1]?.cost).toBeCloseTo(0.003, 12);
        expect(buckets[1]?.label).toMatch(/10:00$/);
    });

    it('sumUsage：汇总调用数/费用/token', () => {
        const totals = sumUsage([
            record({ occurredAt: 1, cost: 0.001 }),
            record({ occurredAt: 2, cost: 0.002 }),
        ]);
        expect(totals.calls).toBe(2);
        expect(totals.cost).toBeCloseTo(0.003, 12);
        expect(totals.inputTokens).toBe(200);
        expect(totals.outputTokens).toBe(100);
    });
});
