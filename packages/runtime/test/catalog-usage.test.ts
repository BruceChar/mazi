import { describe, expect, it } from 'vitest';
import type { ProviderConfig } from '../src/config.js';
import { modelIdOf, offeringIdOf, providerIdOf } from '../src/provider/catalog/contract.js';
import {
    CatalogService,
    MemoryCatalogStore,
    observedCatalogFromProviderConfigs,
} from '../src/provider/catalog/index.js';

/** providers.json 形态：默认模型 deepseek-flash，带 provider 级价目。 */
function providerConfig(): ProviderConfig {
    return {
        id: 'deepseek',
        vendor: 'deepseek',
        models: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }],
        driver: { type: 'pi-ai', provider: 'deepseek', model: 'deepseek-flash' },
        pricing: {
            currency: 'USD',
            base: { inputPerMTok: 1, outputPerMTok: 4, cacheReadPerMTok: 0.02 },
            tiers: [],
            effectiveAt: 0,
            version: 'v1',
        },
    };
}

describe('catalog 使用账本（花费凭证）', () => {
    it('既有目录缺 providers.json 默认模型时，导入后补出 offering+价目并可结算', async () => {
        const store = new MemoryCatalogStore();
        const service = await CatalogService.open({ store, now: () => 1000 });

        // 造一份“陈旧”目录：只有 deepseek-v4-flash（模拟远程发现过、与本地配置不一致）。
        const stale = observedCatalogFromProviderConfigs([
            {
                ...providerConfig(),
                models: [{ id: 'deepseek-v4-flash' }],
                driver: { type: 'pi-ai', provider: 'deepseek', model: 'deepseek-v4-flash' },
            },
        ]);
        await service.sync(stale.catalog, { source: 'vendor-sync' });
        expect(service.epoch()).toBeGreaterThan(0);

        const wanted = offeringIdOf(providerIdOf('deepseek'), modelIdOf('deepseek-flash'));
        expect(service.snapshot().offerings.some((view) => view.offering.id === wanted)).toBe(false);

        // providers.json 对账导入：默认模型 deepseek-flash 补出 offering + 价目。
        const observed = observedCatalogFromProviderConfigs([providerConfig()]);
        await service.sync(observed.catalog, { source: 'manual-import' });

        const pin = service.pin(wanted);
        await service.settle(pin, { inputTokens: 100, outputTokens: 50 });
        const records = await service.usageRecords();
        expect(records).toHaveLength(1);
        expect(records[0]?.modelId).toBe('deepseek-flash');
        expect(records[0]?.cost).toBeGreaterThan(0);
    });
});
