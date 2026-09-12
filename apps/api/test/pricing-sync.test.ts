import 'reflect-metadata';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRuntimeService } from '../src/common/runtime.service.js';

const PAGE = `<html><body>
模型 deepseek-flash (1) deepseek-v4-pro (2) BASE URL
价格 (3) 百万tokens输入 （缓存命中） 空闲时段 0.02元 0.15元 高峰时段 0.04元 0.30元
百万tokens输入 （缓存未命中） 空闲时段 1元 4.5元 高峰时段 2元 9.0元
百万tokens输出 空闲时段 4元 13.5元 高峰时段 8元 27.0元
</body></html>`;

interface ProvidersFile {
    providers: Array<{
        id: string;
        models: Array<{
            id: string;
            pricing?: { currency?: string; base?: { inputPerMTok?: number } };
        }>;
        driver: { model?: string };
        pricing?: {
            currency?: string;
            version?: string;
            base?: { inputPerMTok?: number };
            tiers?: unknown[];
        };
    }>;
}

function writeProviders(home: string): void {
    writeFileSync(
        join(home, 'providers.json'),
        JSON.stringify({
            providers: [
                {
                    id: 'ds',
                    driver: { type: 'pi-ai', provider: 'deepseek', model: 'deepseek-flash' },
                    models: [
                        { id: 'stale-model' },
                        { id: 'deepseek-flash', name: 'flash' },
                    ],
                    pricing: {
                        currency: 'USD',
                        base: { inputPerMTok: 0.14, outputPerMTok: 0.28 },
                        tiers: [],
                        effectiveAt: 0,
                        version: 'catalog',
                    },
                },
            ],
        }),
    );
}

function readProviders(home: string): ProvidersFile {
    return JSON.parse(readFileSync(join(home, 'providers.json'), 'utf8')) as ProvidersFile;
}

/** 端点模型发现返回与价目页一致的清单，避免启动期后台同步与断言竞争。 */
function stubModelEndpoint(): void {
    vi.stubGlobal('fetch', async (input: unknown) => {
        if (String(input).endsWith('/models')) {
            return new Response(
                JSON.stringify({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            );
        }
        return new Response('boom', { status: 500 });
    });
}

describe('ApiRuntimeService 官网价目抓取', () => {
    let home: string | undefined;
    afterEach(() => {
        if (home) rmSync(home, { recursive: true, force: true });
        home = undefined;
        delete process.env.MAZI_HOME;
        delete process.env.DEEPSEEK_API_KEY;
        vi.unstubAllGlobals();
    });

    it('确定性解析：写入人民币官方价 + 官网模型清单', async () => {
        home = mkdtempSync(join(tmpdir(), 'mazi-pricing-'));
        process.env.MAZI_HOME = home;
        writeProviders(home);
        stubModelEndpoint();
        const service = new ApiRuntimeService();
        process.env.DEEPSEEK_API_KEY = 'sk-test';
        service.setPricingFetch(async () => new Response(PAGE, { status: 200 }));

        const result = await service.syncOfficialPricing();
        expect(result.error).toBeUndefined();
        expect(result.modelIds).toEqual(['deepseek-flash', 'deepseek-v4-pro']);

        const ds = readProviders(home).providers[0];
        expect(ds.pricing?.currency).toBe('CNY');
        expect(ds.pricing?.base?.inputPerMTok).toBe(1);
        expect(ds.pricing?.version).toBe('deepseek-2026-09');
        expect(ds.pricing?.tiers?.length).toBeGreaterThan(0);
        // 官网模型清单为权威：陈旧 id 被移除
        expect(ds.models.map((model) => model.id)).toEqual([
            'deepseek-flash',
            'deepseek-v4-pro',
        ]);
        // 逐模型价目：pro 用 pro 的官方单价，而非回落到 flash
        const pro = ds.models.find((model) => model.id === 'deepseek-v4-pro');
        expect(pro?.pricing?.base?.inputPerMTok).toBe(4.5);
    });

    it('确定性解析失败 → Agent 兜底解析并落盘', async () => {
        home = mkdtempSync(join(tmpdir(), 'mazi-pricing-'));
        process.env.MAZI_HOME = home;
        writeProviders(home);
        stubModelEndpoint();
        const service = new ApiRuntimeService();
        service.setPricingFetch(async () => new Response('<html>全新版式无价格表</html>', { status: 200 }));
        service.setPricingAnalyst(async (page) => ({
            sourceUrl: page.url,
            currency: 'CNY',
            models: [
                {
                    id: 'deepseek-flash',
                    tier: 'flash',
                    idle: { inputPerMTok: 1, cacheReadPerMTok: 0.02, outputPerMTok: 4, currency: 'CNY' },
                    peak: { inputPerMTok: 2, cacheReadPerMTok: 0.04, outputPerMTok: 8, currency: 'CNY' },
                },
            ],
        }));

        const result = await service.syncOfficialPricing();
        expect(result.error).toBeUndefined();
        const ds = readProviders(home).providers[0];
        expect(ds.pricing?.currency).toBe('CNY');
        expect(ds.pricing?.base?.inputPerMTok).toBe(1);
    });

    it('解析全失败 → fail-safe，不覆盖既有配置', async () => {
        home = mkdtempSync(join(tmpdir(), 'mazi-pricing-'));
        process.env.MAZI_HOME = home;
        writeProviders(home);
        stubModelEndpoint();
        const service = new ApiRuntimeService();
        service.setPricingFetch(async () => new Response('<html>无表</html>', { status: 200 }));
        service.setPricingAnalyst(async () => null);

        const result = await service.syncOfficialPricing();
        expect(result.error).toBe('parse-failed');
        expect(readProviders(home).providers[0].pricing?.currency).toBe('USD');
    });

    it('目录同步不得覆盖已落地的官方人民币价', async () => {
        home = mkdtempSync(join(tmpdir(), 'mazi-pricing-'));
        process.env.MAZI_HOME = home;
        writeProviders(home);
        stubModelEndpoint();
        const service = new ApiRuntimeService();
        service.setPricingFetch(async () => new Response(PAGE, { status: 200 }));
        await service.syncOfficialPricing();

        service.syncProviderModels();

        const ds = readProviders(home).providers[0];
        expect(ds.pricing?.currency).toBe('CNY');
        expect(ds.pricing?.version).toBe('deepseek-2026-09');
    });
});
