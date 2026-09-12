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
    return {
        sourceUrl,
        currency: 'CNY',
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
