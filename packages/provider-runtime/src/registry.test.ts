import type { ContentType, LLMProvider, LLMRequest } from '@mazi/core';
import { ProviderError } from '@mazi/core';
import { describe, expect, it } from 'vitest';
import type { ProviderConfig } from './config.js';
import { ConfigValidationError } from './config.js';
import type { EconomicsProfile, PerformanceProfile } from './profile.js';
import { ProviderRegistry } from './registry.js';
import { RoutingSupply } from './supply.js';

const caps = {
    supportsToolCalls: true,
    supportsStreaming: true,
    inputTypes: ['text'] as ContentType[],
    outputTypes: ['text'] as ContentType[],
};

function fakeProvider(id: string): LLMProvider {
    return {
        id,
        name: id,
        defaultModel: 'm',
        models: [],
        async ask(_r: LLMRequest) {
            throw new ProviderError('unknown', 'unused');
        },
        async *askStream(_r: LLMRequest) {
            // noop
        },
    };
}

describe('ProviderRegistry（§9.3/§9.4）', () => {
    it('注册/实例化/get/list；未知 provider 报错', () => {
        const registry = new ProviderRegistry(
            { allowFaux: false, adapters: { deepseek: (cfg) => fakeProvider(cfg.id) } },
            [{ id: 'a', adapter: 'deepseek', models: [{ id: 'm1', capabilities: caps }] }],
        );
        expect(registry.list()).toHaveLength(1);
        expect(registry.get('a').id).toBe('a');
        expect(() => registry.get('nope')).toThrow(/not registered/);
    });

    it('重复 provider id / 缺失 adapter 工厂 → 装配错误', () => {
        const configs: ProviderConfig[] = [
            { id: 'a', adapter: 'deepseek', models: [{ id: 'm1', capabilities: caps }] },
        ];
        expect(
            () =>
                new ProviderRegistry(
                    { allowFaux: false, adapters: { deepseek: (c) => fakeProvider(c.id) } },
                    configs,
                ),
        ).not.toThrow();
        expect(
            () =>
                new ProviderRegistry(
                    { allowFaux: false, adapters: { deepseek: (c) => fakeProvider(c.id) } },
                    [configs[0], configs[0]],
                ),
        ).toThrow(ConfigValidationError);
        expect(() => new ProviderRegistry({ allowFaux: false, adapters: {} }, configs)).toThrow(
            /no adapter factory/,
        );
    });

    it('faux：allowFaux=false 拒绝；=true 需工厂', () => {
        const fauxCfg: ProviderConfig = {
            id: 'f',
            adapter: 'faux',
            models: [{ id: 'm1', capabilities: caps }],
        };
        expect(
            () =>
                new ProviderRegistry(
                    { allowFaux: false, adapters: { faux: (c) => fakeProvider(c.id) } },
                    [fauxCfg],
                ),
        ).toThrow(ConfigValidationError);
        const registry = new ProviderRegistry(
            { allowFaux: true, adapters: { faux: (c) => fakeProvider(c.id) } },
            [fauxCfg],
        );
        expect(registry.get('f').id).toBe('f');
    });
});

describe('RoutingSupply（§10）', () => {
    const configs: ProviderConfig[] = [
        { id: 'a', adapter: 'deepseek', models: [{ id: 'm1', capabilities: caps }] },
    ];
    const perf = (): PerformanceProfile => ({
        tokensPerSecond: { p50: 1, p90: 1, p95: 1 },
        ttftMs: { p50: 1, p90: 1, p95: 1 },
        e2eLatencyMs: { p50: 1, p90: 1, p95: 1 },
        errorRate: 0,
        toolCallSchemaCompliance: 0,
        sampleSize: 5,
        windowMs: 3_600_000,
        lastUpdated: 0,
    });
    const econ = (): EconomicsProfile => ({
        avgTaskCostUsd: 0.1,
        avgTokensPerTurn: { input: 10, output: 5 },
        qualitySampleSize: 0,
        retryRate: 0,
        sampleSize: 5,
        lastUpdated: 0,
    });

    it('models() 聚合配置；无画像 → null；health/breakerOpen 透传；无 pricing 回落占位', () => {
        const supply = new RoutingSupply(configs, {
            health: () => 80,
            breakerOpen: () => false,
            profile: () => null,
        });
        const entries = supply.models();
        expect(entries).toHaveLength(1);
        expect(entries[0]?.providerId).toBe('a');
        expect(entries[0]?.performance).toBeNull();
        expect(entries[0]?.economics).toBeNull();
        expect(entries[0]?.health).toBe(80);
        expect(entries[0]?.breakerOpen).toBe(false);
        expect(entries[0]?.pricing.base.inputPerMTok).toBe(0); // UNPRICED 占位
    });

    it('画像查询有值时透传', () => {
        const supply = new RoutingSupply(configs, {
            health: () => 50,
            breakerOpen: () => true,
            profile: (p, m) =>
                p === 'a' && m === 'm1' ? { performance: perf(), economics: econ() } : null,
        });
        const entry = supply.models()[0];
        expect(entry?.performance?.sampleSize).toBe(5);
        expect(entry?.economics?.avgTaskCostUsd).toBeCloseTo(0.1, 6);
        expect(entry?.breakerOpen).toBe(true);
    });
});
