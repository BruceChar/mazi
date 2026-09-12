import { describe, expect, it } from 'vitest';

import {
    buildPricingAnalysisPrompt,
    extractJsonObject,
    parseAgentPricingJson,
    parseDeepseekPricingPage,
    peakMultiplierOf,
} from '../src/deepseek-pricing.js';

const SAMPLE = `
<html><body><div>
模型 deepseek-flash (1) deepseek-v4-pro (2) BASE URL
价格 (3) 百万tokens输入 （缓存命中） 空闲时段 0.02元 0.15元 高峰时段 0.04元 0.30元
百万tokens输入 （缓存未命中） 空闲时段 1元 4.5元 高峰时段 2元 9.0元
百万tokens输出 空闲时段 4元 13.5元 高峰时段 8元 27.0元 并发限制
</div></body></html>
`;

describe('parseDeepseekPricingPage', () => {
    it('parses the official flash/pro idle+peak prices', () => {
        const parsed = parseDeepseekPricingPage(SAMPLE, 'https://example.test/pricing');
        expect(parsed).not.toBeNull();
        const flash = parsed?.models.find((m) => m.tier === 'flash');
        const pro = parsed?.models.find((m) => m.tier === 'pro');
        expect(flash?.id).toBe('deepseek-flash');
        expect(flash?.idle).toMatchObject({
            inputPerMTok: 1,
            cacheReadPerMTok: 0.02,
            outputPerMTok: 4,
            currency: 'CNY',
        });
        expect(flash?.peak).toMatchObject({
            inputPerMTok: 2,
            cacheReadPerMTok: 0.04,
            outputPerMTok: 8,
        });
        expect(pro?.idle).toMatchObject({
            inputPerMTok: 4.5,
            cacheReadPerMTok: 0.15,
            outputPerMTok: 13.5,
        });
        expect(pro?.peak).toMatchObject({
            inputPerMTok: 9,
            cacheReadPerMTok: 0.3,
            outputPerMTok: 27,
        });
        if (flash) expect(peakMultiplierOf(flash)).toBe(2);
    });

    it('returns null when the table is absent', () => {
        expect(parseDeepseekPricingPage('<html>no table</html>', 'x')).toBeNull();
    });

    it('parses context/output length from the page', () => {
        const withWindow = SAMPLE.replace('BASE URL', '上下文长度 1M 输出长度 最大 384K BASE URL');
        const parsed = parseDeepseekPricingPage(withWindow, 'x');
        expect(parsed?.contextWindowTokens).toBe(1_000_000);
        expect(parsed?.maxOutputTokens).toBe(384_000);
    });
});

describe('parseAgentPricingJson', () => {
    it('parses a bare JSON reply into flash/pro tiers', () => {
        const reply = JSON.stringify({
            currency: 'CNY',
            contextWindowTokens: 1_000_000,
            maxOutputTokens: 384_000,
            models: [
                {
                    id: 'deepseek-flash',
                    tier: 'flash',
                    idle: { inputPerMTok: 1, cacheReadPerMTok: 0.02, outputPerMTok: 4 },
                    peak: { inputPerMTok: 2, cacheReadPerMTok: 0.04, outputPerMTok: 8 },
                },
                {
                    id: 'deepseek-v4-pro',
                    idle: { inputPerMTok: 4.5, cacheReadPerMTok: 0.15, outputPerMTok: 13.5 },
                },
            ],
        });
        const parsed = parseAgentPricingJson(reply, 'https://example.test/pricing');
        expect(parsed?.currency).toBe('CNY');
        expect(parsed?.contextWindowTokens).toBe(1_000_000);
        expect(parsed?.maxOutputTokens).toBe(384_000);
        expect(parsed?.models).toHaveLength(2);
        const flash = parsed?.models.find((m) => m.id === 'deepseek-flash');
        expect(flash?.tier).toBe('flash');
        expect(flash?.peak.outputPerMTok).toBe(8);
        // 未给 peak → 回退 idle；tier 由 id 推断为 pro
        const pro = parsed?.models.find((m) => m.id === 'deepseek-v4-pro');
        expect(pro?.tier).toBe('pro');
        expect(pro?.peak).toEqual(pro?.idle);
    });

    it('tolerates markdown fences and surrounding prose', () => {
        const reply = [
            '好的，价格如下：',
            '\u0060\u0060\u0060json',
            '{"currency":"CNY","models":[{"id":"deepseek-flash","idle":{"inputPerMTok":"1","outputPerMTok":"4元"}}]}',
            '\u0060\u0060\u0060',
            '以上。',
        ].join('\n');
        expect(extractJsonObject(reply)).toContain('deepseek-flash');
        const parsed = parseAgentPricingJson(reply, 'x');
        expect(parsed?.models[0]?.idle.inputPerMTok).toBe(1);
        expect(parsed?.models[0]?.idle.outputPerMTok).toBe(4);
    });

    it('rejects non-CNY or malformed payloads', () => {
        expect(parseAgentPricingJson('not json', 'x')).toBeNull();
        expect(parseAgentPricingJson('{"currency":"USD","models":[]}', 'x')).toBeNull();
        expect(parseAgentPricingJson('{"currency":"CNY","models":[{"id":"x"}]}', 'x')).toBeNull();
    });
});

describe('buildPricingAnalysisPrompt', () => {
    it('embeds the url and truncates very long pages', () => {
        const prompt = buildPricingAnalysisPrompt('a'.repeat(30_000), 'https://example.test/p');
        expect(prompt).toContain('https://example.test/p');
        expect(prompt).toContain('"currency":"CNY"');
        expect(prompt.length).toBeLessThan(30_000);
    });
});
