import 'reflect-metadata';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

describe('ApiRuntimeService 模型同步（pi-ai 目录）', () => {
    let home: string | undefined;
    afterEach(() => {
        if (home) rmSync(home, { recursive: true, force: true });
        home = undefined;
        delete process.env.MAZI_HOME;
    });

    it('启动时同步 deepseek 模型列表；未知厂商保留原配置', () => {
        home = mkdtempSync(join(tmpdir(), 'mazi-sync-'));
        process.env.MAZI_HOME = home;
        writeFileSync(
            join(home, 'providers.json'),
            JSON.stringify({
                providers: [
                    {
                        id: 'ds',
                        driver: { type: 'pi-ai', provider: 'deepseek', model: 'deepseek-v4-flash' },
                        models: [{ id: 'stale-model' }],
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

        new ApiRuntimeService();

        const parsed = JSON.parse(readFileSync(join(home, 'providers.json'), 'utf8')) as {
            providers: Array<{
                id: string;
                models: Array<{ id: string }>;
                pricing?: { base?: { cacheReadPerMTok?: number } };
            }>;
        };
        const ds = parsed.providers.find((provider) => provider.id === 'ds');
        // 目录模型被加入
        expect(ds?.models.some((model) => model.id === 'deepseek-v4-flash')).toBe(true);
        // 目录外模型保留（合并，不删除）
        expect(ds?.models.some((model) => model.id === 'stale-model')).toBe(true);
        // 目录补充模型（deepseek-v41-flash）被写入
        expect(ds?.models.some((model) => model.id === 'deepseek-v41-flash')).toBe(true);
        // 平台价格从目录补全（cacheRead）
        expect(ds?.pricing?.base?.cacheReadPerMTok).toBeCloseTo(0.0028, 10);
        const faux = parsed.providers.find((provider) => provider.id === 'faux');
        expect(faux?.models).toEqual([{ id: 'keep-model' }]);
    });
});
