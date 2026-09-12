import { describe, expect, it } from 'vitest';

import { parseDeepseekPricingPage, peakMultiplierOf } from '../src/deepseek-pricing.js';

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
        expect(flash?.idle).toMatchObject({ inputPerMTok: 1, cacheReadPerMTok: 0.02, outputPerMTok: 4, currency: 'CNY' });
        expect(flash?.peak).toMatchObject({ inputPerMTok: 2, cacheReadPerMTok: 0.04, outputPerMTok: 8 });
        expect(pro?.idle).toMatchObject({ inputPerMTok: 4.5, cacheReadPerMTok: 0.15, outputPerMTok: 13.5 });
        expect(pro?.peak).toMatchObject({ inputPerMTok: 9, cacheReadPerMTok: 0.3, outputPerMTok: 27 });
        if (flash) expect(peakMultiplierOf(flash)).toBe(2);
    });

    it('returns null when the table is absent', () => {
        expect(parseDeepseekPricingPage('<html>no table</html>', 'x')).toBeNull();
    });
});
