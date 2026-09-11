import { modelIdOf, offeringIdOf, providerIdOf } from '@mazi/core';
import { describe, expect, it } from 'vitest';
import type { ProviderConfig } from '../src/config.js';
import { CatalogService, MemoryCatalogStore } from '../src/catalog/index.js';
import { observedCatalogFromProviderConfigs } from '../src/catalog/index.js';

function providerConfig(over: Partial<ProviderConfig> = {}): ProviderConfig {
    return {
        id: 'deepseek',
        vendor: 'deepseek',
        tags: ['official'],
        models: [
            {
                id: 'deepseek-v4-flash',
                name: 'V4 Flash',
                contextWindow: 128000,
                maxTokens: 8192,
                supportsTools: true,
                supportsThinking: true,
                supportsVision: false,
            },
            { id: 'deepseek-v4-pro', contextWindow: 256000, supportsTools: true },
        ],
        driver: { type: 'pi-ai', provider: 'deepseek', model: 'deepseek-v4-flash' },
        pricing: {
            currency: 'USD',
            base: { inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0.1 },
            tiers: [],
            effectiveAt: 1000,
            version: 'catalog',
        },
        ...over,
    };
}

describe('catalog seed：源配置 → v1 映射（设计文档 §12）', () => {
    it('provider/models 拆成 vendor/provider/model/offering，定价只挂 driver.model', () => {
        const { catalog, driverConfigs } = observedCatalogFromProviderConfigs([providerConfig()]);
        expect(catalog.providers).toHaveLength(1);
        const provider = catalog.providers[0];
        expect(provider?.id).toBe('deepseek');
        expect(provider?.driverType).toBe('pi-ai');
        expect(provider?.tags).toEqual(['official']);
        expect(provider?.models).toHaveLength(2);
        const flash = provider?.models.find((m) => m.id === 'deepseek-v4-flash');
        const pro = provider?.models.find((m) => m.id === 'deepseek-v4-pro');
        expect(flash?.pricing?.base.inputPerMTok).toBe(1);
        expect(pro?.pricing).toBeNull();
        expect(flash?.vendor.id).toBe('deepseek');
        expect(driverConfigs).toEqual([
            { id: 'default', offeringId: 'deepseek/deepseek-v4-flash', fallbackOfferingIds: [] },
        ]);
    });

    it('导入后经 sync 入库：默认型号有价、其余无价不可路由', async () => {
        const service = await CatalogService.open({ store: new MemoryCatalogStore(), now: () => 2000 });
        const { catalog, driverConfigs } = observedCatalogFromProviderConfigs([providerConfig()]);
        const result = await service.sync(catalog, { source: 'manual-import', now: 2000 });
        expect(result.changed).toBe(true);
        const driverConfig = driverConfigs[0];
        if (driverConfig === undefined) throw new Error('seed produced no driver config');
        await service.setDriverConfig(driverConfig);
        const snapshot = service.snapshot();
        expect(snapshot.offerings).toHaveLength(2);
        const flashId = offeringIdOf(providerIdOf('deepseek'), modelIdOf('deepseek-v4-flash'));
        const proId = offeringIdOf(providerIdOf('deepseek'), modelIdOf('deepseek-v4-pro'));
        const flash = snapshot.offerings.find((view) => view.offering.id === flashId);
        const pro = snapshot.offerings.find((view) => view.offering.id === proId);
        expect(flash?.pricing?.version).toBe('catalog');
        expect(pro?.pricing).toBeNull();
        // 定价只有默认型号可结算
        expect(() => service.pin(proId)).toThrow(/no active pricing/);
        expect(service.pin(flashId).catalogEpoch).toBe(1);
    });

    it('缺 models 的配置回退到 driver.model 单型号', () => {
        const { catalog } = observedCatalogFromProviderConfigs([
            providerConfig({ models: undefined }),
        ]);
        expect(catalog.providers[0]?.models.map((m) => m.id)).toEqual(['deepseek-v4-flash']);
    });
});
