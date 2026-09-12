/**
 * DeepSeek 官方价目页解析器（选项 2：从官网获取，而非代码内写死）。
 *
 * 页面为 Docusaurus HTML，价格表文本形如：
 *   缓存命中）空闲时段 0.02元 0.15元 高峰时段 0.04元 0.30元
 *   百万tokens输入（缓存未命中）空闲时段 1元 4.5元 高峰时段 2元 9.0元
 *   百万tokens输出 空闲时段 4元 13.5元 高峰时段 8元 27.0元
 * 两列分别为 flash / pro。解析失败返回 null（调用方回退/告警，不静默覆盖）。
 */

import type { ProviderModelPricing } from '@mazi/core';

export interface ParsedModelPricing {
    /** 页面上的模型名，如 deepseek-flash / deepseek-v4-pro。 */
    id: string;
    tier: 'flash' | 'pro';
    idle: ProviderModelPricing;
    peak: ProviderModelPricing;
}

export interface ParsedDeepseekPricing {
    sourceUrl: string;
    currency: 'CNY';
    models: ParsedModelPricing[];
    /** 页面标注的上下文长度（token）；缺省 = 未解析到 */
    contextWindowTokens?: number;
    /** 页面标注的最大输出长度（token） */
    maxOutputTokens?: number;
}

/** HTML → 纯文本（去脚本/样式/标签、反转义、压缩空白）。 */
export function htmlToText(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

const NUM = '([0-9]+(?:\\.[0-9]+)?)';

/** '1M' / '384K' → token 数。 */
function tokenCount(value: string, unit: string): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * (unit.toLowerCase() === 'm' ? 1_000_000 : 1_000));
}

export function parseDeepseekPricingPage(
    html: string,
    sourceUrl: string,
): ParsedDeepseekPricing | null {
    const text = htmlToText(html);
    // 模型名列：模型 deepseek-xxx (n) deepseek-yyy (n)
    const models = [...text.matchAll(/deepseek-[a-z0-9.-]+/gi)].map((m) => m[0]);
    const flashId = models.find((id) => /flash/i.test(id));
    const proId = models.find((id) => /pro|reasoner/i.test(id));
    if (!flashId || !proId) return null;

    const re = new RegExp(
        `缓存命中）\\s*空闲时段\\s*${NUM}元\\s*${NUM}元\\s*高峰时段\\s*${NUM}元\\s*${NUM}元` +
            `\\s*百万tokens输入\\s*（缓存未命中）\\s*空闲时段\\s*${NUM}元\\s*${NUM}元\\s*高峰时段\\s*${NUM}元\\s*${NUM}元` +
            `\\s*百万tokens输出\\s*空闲时段\\s*${NUM}元\\s*${NUM}元\\s*高峰时段\\s*${NUM}元\\s*${NUM}元`,
    );
    const match = text.match(re);
    if (!match) return null;
    const n = match.slice(1).map(Number);
    if (n.length !== 12 || n.some((value) => !Number.isFinite(value))) return null;

    const price = (input: number, cached: number, output: number): ProviderModelPricing => ({
        inputPerMTok: input,
        cacheReadPerMTok: cached,
        outputPerMTok: output,
        currency: 'CNY',
    });
    // 上下文/输出长度（页面标「上下文长度 1M 输出长度 最大 384K」）
    const ctx = text.match(/上下文长度\s*([0-9.]+)\s*([KMkm])/);
    const out = text.match(/输出长度\s*最大\s*([0-9.]+)\s*([KMkm])/);
    const contextWindowTokens = ctx ? tokenCount(ctx[1] as string, ctx[2] as string) : undefined;
    const maxOutputTokens = out ? tokenCount(out[1] as string, out[2] as string) : undefined;
    return {
        sourceUrl,
        currency: 'CNY',
        ...(contextWindowTokens ? { contextWindowTokens } : {}),
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
        models: [
            {
                id: flashId,
                tier: 'flash',
                idle: price(n[4] as number, n[0] as number, n[8] as number),
                peak: price(n[6] as number, n[2] as number, n[10] as number),
            },
            {
                id: proId,
                tier: 'pro',
                idle: price(n[5] as number, n[1] as number, n[9] as number),
                peak: price(n[7] as number, n[3] as number, n[11] as number),
            },
        ],
    };
}

/** 送入 Agent 的页面正文上限（价格表通常在页面前部；避免撑爆上下文）。 */
export const MAX_PRICING_PAGE_CHARS = 24_000;

/**
 * 交给 Agent 的价目页解析提示：要求只回一个 JSON 对象（无解释/Markdown），
 * 便于 {@link parseAgentPricingJson} 严格解析；解析失败视为无结果（调用方保留既有配置）。
 */
export function buildPricingAnalysisPrompt(pageText: string, sourceUrl: string): string {
    const body =
        pageText.length > MAX_PRICING_PAGE_CHARS
            ? pageText.slice(0, MAX_PRICING_PAGE_CHARS)
            : pageText;
    return [
        '你是计费配置抽取器。下面是模型厂商官方价目页的纯文本，请抽取每个模型的价格（元 / 百万 tokens）。',
        '只输出一个 JSON 对象，不要任何解释文字，也不要用 Markdown 代码块。JSON 结构：',
        '{"currency":"CNY","contextWindowTokens":<数>,"maxOutputTokens":<数>,"models":[{"id":"<模型id>","tier":"flash|pro","idle":{"inputPerMTok":<数>,"cacheReadPerMTok":<数>,"outputPerMTok":<数>},"peak":{"inputPerMTok":<数>,"cacheReadPerMTok":<数>,"outputPerMTok":<数>}}]}',
        '说明：空闲时段价填 idle，高峰时段价填 peak；页面只给单一价格时 peak 与 idle 相同。数字不要带单位或千分位（1M = 1000000）。',
        `来源：${sourceUrl}`,
        '页面文本：',
        body,
    ].join('\n');
}

/** 从 Agent 回复中抽取首个完整 JSON 对象（容忍 Markdown 代码块与前后解释文字）。 */
export function extractJsonObject(reply: string): string | null {
    const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const source = fenced?.[1] ?? reply;
    const start = source.indexOf('{');
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
        const char = source[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') inString = true;
        else if (char === '{') depth += 1;
        else if (char === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(start, index + 1);
        }
    }
    return null;
}

function numberOrUndefined(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Number(value.replace(/[^0-9.]/g, ''));
        if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
}

function priceFromUnknown(raw: unknown): ProviderModelPricing | undefined {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const record = raw as Record<string, unknown>;
    const inputPerMTok = numberOrUndefined(record.inputPerMTok);
    const outputPerMTok = numberOrUndefined(record.outputPerMTok);
    if (inputPerMTok === undefined || outputPerMTok === undefined) return undefined;
    const cacheReadPerMTok = numberOrUndefined(record.cacheReadPerMTok);
    return {
        inputPerMTok,
        outputPerMTok,
        ...(cacheReadPerMTok !== undefined ? { cacheReadPerMTok } : {}),
        currency: 'CNY',
    };
}

/**
 * 解析 Agent 按 {@link buildPricingAnalysisPrompt} 返回的 JSON；不合法 → null。
 * 仅接受人民币（官网价目页口径），非 CNY 一律拒绝，避免把 USD 当 CNY 静默写入。
 */
export function parseAgentPricingJson(
    reply: string,
    sourceUrl: string,
): ParsedDeepseekPricing | null {
    const raw = extractJsonObject(reply);
    if (raw === null) return null;
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return null;
    }
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    const currency = typeof record.currency === 'string' ? record.currency.toUpperCase() : 'CNY';
    if (currency !== 'CNY') return null;
    if (!Array.isArray(record.models) || record.models.length === 0) return null;
    const models: ParsedModelPricing[] = [];
    for (const item of record.models) {
        if (typeof item !== 'object' || item === null) continue;
        const entry = item as Record<string, unknown>;
        const id = typeof entry.id === 'string' ? entry.id.trim() : '';
        if (id.length === 0) continue;
        const idle = priceFromUnknown(entry.idle);
        if (idle === undefined) continue;
        const peak = priceFromUnknown(entry.peak) ?? idle;
        const tier: 'flash' | 'pro' =
            entry.tier === 'pro' || entry.tier === 'flash'
                ? entry.tier
                : /pro|reasoner/i.test(id)
                  ? 'pro'
                  : 'flash';
        models.push({ id, tier, idle, peak });
    }
    if (models.length === 0) return null;
    const contextWindowTokens = numberOrUndefined(record.contextWindowTokens);
    const maxOutputTokens = numberOrUndefined(record.maxOutputTokens);
    return {
        sourceUrl,
        currency: 'CNY',
        ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        models,
    };
}

/** 高峰/空闲倍率（用于生成 PricingSchedule.tiers）；各成分一致时返回该倍率，否则 null。 */
export function peakMultiplierOf(model: ParsedModelPricing): number | null {
    const ratios = [
        model.idle.inputPerMTok ? (model.peak.inputPerMTok ?? 0) / model.idle.inputPerMTok : null,
        model.idle.cacheReadPerMTok
            ? (model.peak.cacheReadPerMTok ?? 0) / model.idle.cacheReadPerMTok
            : null,
        model.idle.outputPerMTok
            ? (model.peak.outputPerMTok ?? 0) / model.idle.outputPerMTok
            : null,
    ].filter((value): value is number => value !== null);
    if (ratios.length === 0) return null;
    const [first] = ratios;
    return ratios.every((value) => Math.abs(value - (first as number)) < 1e-9)
        ? (first as number)
        : null;
}
