import type { LLMProvider, LLMRequest } from '@mazi/core';
import { describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { createPricingAnalyst } from '../src/provider/pricing-analyst.js';

function fakeProvider(reply: string, record?: (request: LLMRequest) => void): LLMProvider {
    return {
        id: 'ds',
        name: 'ds',
        defaultModel: 'deepseek-flash',
        models: [],
        async ask(request: LLMRequest) {
            record?.(request);
            return {
                model: 'deepseek-flash',
                content: [{ type: 'text', text: reply }],
                finishReason: 'stop',
            };
        },
        async *askStream() {
            // unused
        },
    };
}

function config(): RuntimeConfig {
    return {
        providers: [
            {
                id: 'ds',
                driver: { type: 'pi-ai', provider: 'deepseek', model: 'deepseek-flash' },
                models: [{ id: 'deepseek-flash' }],
                pricing: { currency: 'USD', base: {}, tiers: [], effectiveAt: 0, version: 'v1' },
            },
        ],
        tools: [],
    } as unknown as RuntimeConfig;
}

describe('createPricingAnalyst', () => {
    it('把页面交给模型并把 JSON 回复解析为官方价', async () => {
        let seen: LLMRequest | undefined;
        const provider = fakeProvider(
            JSON.stringify({
                currency: 'CNY',
                models: [
                    {
                        id: 'deepseek-flash',
                        idle: { inputPerMTok: 1, cacheReadPerMTok: 0.02, outputPerMTok: 4 },
                        peak: { inputPerMTok: 2, cacheReadPerMTok: 0.04, outputPerMTok: 8 },
                    },
                ],
            }),
            (request) => {
                seen = request;
            },
        );
        const analyst = createPricingAnalyst(config(), { provider });
        expect(analyst).toBeDefined();
        const parsed = await analyst?.({ url: 'https://example.test/p', text: '页面正文' });
        expect(parsed?.models[0]?.idle.inputPerMTok).toBe(1);
        // 提示词里带上了 URL 与页面正文
        const text = seen?.messages[0]?.content[0];
        expect(JSON.stringify(text)).toContain('https://example.test/p');
        expect(JSON.stringify(text)).toContain('页面正文');
    });

    it('无 deepseek provider → undefined', () => {
        const cfg = { providers: [], tools: [] } as unknown as RuntimeConfig;
        expect(createPricingAnalyst(cfg)).toBeUndefined();
    });
});
