import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { apiKeyStatus, loadSecrets, saveProviderApiKey, withProviderSecrets } from '../src/secrets.js';

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mazi-secrets-'));
    dirs.push(dir);
    return dir;
}

function config(): RuntimeConfig {
    return {
        providers: [
            {
                id: 'deepseek',
                driver: { type: 'pi-ai', provider: 'deepseek', model: 'deepseek-flash' },
                pricing: { currency: 'CNY', base: {}, tiers: [], effectiveAt: 0, version: 'v1' },
                models: [{ id: 'deepseek-flash' }],
            },
        ],
        tools: [],
    } as unknown as RuntimeConfig;
}

describe('secrets (API Key)', () => {
    it('保存/读取/清除 provider API Key，并注入 driver.apiKey', () => {
        const dir = tmp();
        expect(loadSecrets(dir).providers).toBeUndefined();

        saveProviderApiKey('deepseek', 'sk-secret', dir);
        expect(loadSecrets(dir).providers?.deepseek?.apiKey).toBe('sk-secret');
        expect(apiKeyStatus(loadSecrets(dir))).toEqual({ deepseek: true });

        const injected = withProviderSecrets(config(), loadSecrets(dir));
        expect(injected.providers[0]?.driver.apiKey).toBe('sk-secret');

        // 空串 = 清除
        saveProviderApiKey('deepseek', '', dir);
        expect(loadSecrets(dir).providers).toEqual({});
        expect(apiKeyStatus(loadSecrets(dir))).toEqual({});
    });

    it('密钥落盘为独立文件且不与 providers.json 混在一起（0600 权限）', () => {
        const dir = tmp();
        saveProviderApiKey('deepseek', 'sk-2', dir);
        const raw = JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8')) as {
            providers?: Record<string, { apiKey?: string }>;
        };
        expect(raw.providers?.deepseek?.apiKey).toBe('sk-2');
        if (process.platform !== 'win32') {
            expect(statSync(join(dir, 'secrets.json')).mode & 0o777).toBe(0o600);
        }
    });

    it('显式 driver.apiKey 优先于 secrets 注入', () => {
        const dir = tmp();
        saveProviderApiKey('deepseek', 'sk-from-secrets', dir);
        const cfg = config();
        cfg.providers[0]!.driver.apiKey = 'sk-explicit';
        const injected = withProviderSecrets(cfg, loadSecrets(dir));
        expect(injected.providers[0]?.driver.apiKey).toBe('sk-explicit');
    });
});
