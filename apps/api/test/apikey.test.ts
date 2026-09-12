import 'reflect-metadata';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRuntimeService } from '../src/common/runtime.service.js';

function writeProviders(home: string): void {
    writeFileSync(
        join(home, 'providers.json'),
        JSON.stringify({
            providers: [
                {
                    id: 'deepseek',
                    vendor: 'deepseek',
                    driver: { type: 'pi-ai', provider: 'deepseek', model: 'deepseek-flash' },
                    models: [{ id: 'deepseek-flash' }],
                    pricing: { currency: 'CNY', base: {}, tiers: [], effectiveAt: 0, version: 'deepseek-2026-09' },
                },
            ],
        }),
    );
}

describe('ApiRuntimeService API Key（secrets.json）', () => {
    let home: string | undefined;
    afterEach(() => {
        if (home) rmSync(home, { recursive: true, force: true });
        home = undefined;
        delete process.env.MAZI_HOME;
        vi.unstubAllGlobals();
    });

    it('保存/清除 provider Key，overview 只暴露是否已配置', async () => {
        home = mkdtempSync(join(tmpdir(), 'mazi-apikey-'));
        process.env.MAZI_HOME = home;
        writeProviders(home);
        // 避免启动期后台端点发现走真实网络
        vi.stubGlobal('fetch', async () => new Response('boom', { status: 500 }));

        const service = new ApiRuntimeService();
        expect(service.overview().apiKeySet.deepseek).toBeUndefined();

        await service.setApiKey('deepseek', 'sk-test-key');
        expect(service.overview().apiKeySet.deepseek).toBe(true);
        // 明文写入独立密钥文件，不回显在 overview
        const secrets = JSON.parse(readFileSync(join(home, 'secrets.json'), 'utf8')) as {
            providers?: Record<string, { apiKey?: string }>;
        };
        expect(secrets.providers?.deepseek?.apiKey).toBe('sk-test-key');
        expect(JSON.stringify(service.overview())).not.toContain('sk-test-key');

        await service.setApiKey('deepseek', '');
        expect(service.overview().apiKeySet.deepseek).toBeFalsy();
    });
});
