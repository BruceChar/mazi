import 'reflect-metadata';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRuntimeService } from '../src/common/runtime.service.js';

function pricing() {
    return {
        currency: 'USD',
        base: { inputPerMTok: 1, outputPerMTok: 2 },
        tiers: [],
        effectiveAt: 0,
        version: 'v1',
    };
}

function writeProviders(home: string): void {
    writeFileSync(
        join(home, 'providers.json'),
        JSON.stringify({
            providers: [
                {
                    id: 'ds',
                    driver: { type: 'pi-ai', provider: 'deepseek', model: 'deepseek-v41-flash' },
                    models: [
                        { id: 'stale-model' },
                        { id: 'deepseek-v41-flash', name: 'bogus' },
                    ],
                    pricing: pricing(),
                },
                {
                    id: 'faux',
                    driver: { type: 'pi-ai', provider: 'faux', model: 'faux-model' },
                    models: [{ id: 'keep-model' }],
                    pricing: pricing(),
                },
            ],
        }),
    );
}

function readProviders(home: string): {
    providers: Array<{
        id: string;
        models: Array<{ id: string }>;
        driver: { model?: string };
        pricing?: { base?: { cacheReadPerMTok?: number } };
    }>;
} {
    return JSON.parse(readFileSync(join(home, 'providers.json'), 'utf8'));
}

describe('ApiRuntimeService 模型同步（权威替换 + 在线发现）', () => {
    let home: string | undefined;
    afterEach(() => {
        if (home) rmSync(home, { recursive: true, force: true });
        home = undefined;
        delete process.env.MAZI_HOME;
        delete process.env.DEEPSEEK_API_KEY;
        vi.unstubAllGlobals();
    });

    it('启动离线同步：陈旧/厂商未发布模型被移除，未知厂商保留原配置', () => {
        home = mkdtempSync(join(tmpdir(), 'mazi-sync-'));
        process.env.MAZI_HOME = home;
        writeProviders(home);

        new ApiRuntimeService();

        const parsed = readProviders(home);
        const ds = parsed.providers.find((provider) => provider.id === 'ds');
        const ids = (ds?.models ?? []).map((model) => model.id);
        expect(ids).toContain('deepseek-v4-flash');
        // 权威替换：未在目录中的陈旧模型被移除
        expect(ids).not.toContain('stale-model');
        expect(ids).not.toContain('deepseek-v41-flash');
        // driver.model 被修正为有效模型
        expect(ids).toContain(ds?.driver.model);
        // 平台价格从目录补全（DeepSeek 官方人民币价：base=空闲价 flash cacheRead=0.02 元/MTok）
        expect(ds?.pricing?.base?.cacheReadPerMTok).toBeCloseTo(0.02, 10);
        expect(ds?.pricing?.currency).toBe('CNY');
        // 高峰时段 ×2（北京时间周中 9-12/14-18 → UTC 1-4/6-10，UTC 星期 1-5）
        const tiers = ds?.pricing?.tiers as Array<Record<string, unknown>> | undefined;
        expect(tiers?.[0]).toMatchObject({ name: 'peak', multiplier: 2, windowHoursUtc: [1, 4] });
        const faux = parsed.providers.find((provider) => provider.id === 'faux');
        expect(faux?.models).toEqual([{ id: 'keep-model' }]);
    });

    it('在线同步：以厂商 /models 返回为准，修正 driver.model 并移除 v41', async () => {
        home = mkdtempSync(join(tmpdir(), 'mazi-sync-'));
        process.env.MAZI_HOME = home;
        process.env.DEEPSEEK_API_KEY = 'sk-test';
        writeProviders(home);
        const urls: string[] = [];
        vi.stubGlobal('fetch', async (input: unknown) => {
            urls.push(String(input));
            return new Response(
                JSON.stringify({ data: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-flash' }] }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            );
        });

        const service = new ApiRuntimeService();
        await service.syncConfig();

        const ds = readProviders(home).providers.find((provider) => provider.id === 'ds');
        // parseModelIds 去重并排序，保证同步结果稳定
        expect((ds?.models ?? []).map((model) => model.id)).toEqual([
            'deepseek-flash',
            'deepseek-v4-pro',
        ]);
        expect(ds?.driver.model).toBe('deepseek-flash');
        expect(urls.some((url) => url.endsWith('/models'))).toBe(true);
    });

    it('在线失败 → 回退本地目录，仍移除 v41 且不误删 faux', async () => {
        home = mkdtempSync(join(tmpdir(), 'mazi-sync-'));
        process.env.MAZI_HOME = home;
        process.env.DEEPSEEK_API_KEY = 'sk-test';
        writeProviders(home);
        vi.stubGlobal('fetch', async () => new Response('boom', { status: 500 }));

        const service = new ApiRuntimeService();
        const result = await service.syncProviderModelsOnline();

        const parsed = readProviders(home);
        const ds = parsed.providers.find((provider) => provider.id === 'ds');
        expect((ds?.models ?? []).map((model) => model.id)).not.toContain('deepseek-v41-flash');
        expect(result.warnings.some((warning) => warning.includes('ds'))).toBe(true);
        expect(parsed.providers.find((provider) => provider.id === 'faux')?.models).toEqual([
            { id: 'keep-model' },
        ]);
    });
});
