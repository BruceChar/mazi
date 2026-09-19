/**
 * cost-ledger —— 用户花费账本的线协议与小时聚合（api/webui 共享，纯函数）。
 *
 * 数据源：每轮 LLM 调用落地的 UsageRecord（GET /api/catalog/usage）。
 * 最细展示粒度为**小时**（见 docs/webui.md §3.2）。
 */

/** 花费凭证视图（@mazi/runtime UsageRecord 的结构投影）。 */
export interface UsageRecordView {
    id: string;
    offeringId: string;
    modelId: string;
    providerId: string;
    pricingPlanId: string;
    catalogEpoch: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    /** 已按派发钉死价目结算的费用（币种见 currency）。 */
    cost: number;
    currency: string;
    occurredAt: number;
}

/** 小时桶（最细粒度 = 小时，本地时区整点）。 */
export interface UsageHourBucket {
    /** 桶起点（本地整点 epoch ms）。 */
    hourStart: number;
    /** 可读标签 YYYY-MM-DD HH:00。 */
    label: string;
    calls: number;
    cost: number;
    currency: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
}

/** 本地整点（分钟/秒/毫秒清零）。 */
export function hourStartOf(ts: number): number {
    const date = new Date(ts);
    date.setMinutes(0, 0, 0);
    return date.getTime();
}

function hourLabel(ts: number): string {
    const date = new Date(ts);
    const pad = (value: number): string => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:00`;
}

/** 按小时聚合凭证；hourStart 降序（最新在前）。 */
export function groupUsageByHour(records: readonly UsageRecordView[]): UsageHourBucket[] {
    const buckets = new Map<number, UsageHourBucket>();
    for (const record of records) {
        const hourStart = hourStartOf(record.occurredAt);
        const bucket = buckets.get(hourStart) ?? {
            hourStart,
            label: hourLabel(hourStart),
            calls: 0,
            cost: 0,
            currency: record.currency || 'USD',
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
        };
        bucket.calls += 1;
        bucket.cost += record.cost;
        bucket.inputTokens += record.inputTokens;
        bucket.outputTokens += record.outputTokens;
        bucket.cacheReadTokens += record.cacheReadTokens;
        bucket.cacheWriteTokens += record.cacheWriteTokens;
        if (record.currency) bucket.currency = record.currency;
        buckets.set(hourStart, bucket);
    }
    return [...buckets.values()].sort((a, b) => b.hourStart - a.hourStart);
}

/** 汇总（总花费 / 总 token / 调用数）。 */
export function sumUsage(records: readonly UsageRecordView[]): {
    calls: number;
    cost: number;
    currency: string;
    inputTokens: number;
    outputTokens: number;
} {
    let cost = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let currency = 'USD';
    for (const record of records) {
        cost += record.cost;
        inputTokens += record.inputTokens;
        outputTokens += record.outputTokens;
        if (record.currency) currency = record.currency;
    }
    return { calls: records.length, cost, currency, inputTokens, outputTokens };
}
