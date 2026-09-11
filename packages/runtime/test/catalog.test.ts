import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelCapabilities } from '@mazi/core';
import { modelIdOf, offeringIdOf, providerIdOf } from '@mazi/core';
import { describe, expect, it } from 'vitest';
import {
    CatalogService,
    FileCatalogStore,
    MemoryCatalogStore,
    type ObservedCatalog,
    type ObservedModel,
    type ObservedProvider,
    routeOffering,
} from '../src/catalog/index.js';

const CAPS: ModelCapabilities = {
    contextWindow: 128000,
    maxTokens: 8192,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: false,
};

function observedModel(over: Partial<ObservedModel> = {}): ObservedModel {
    return {
        id: 'deepseek-v4-flash',
        name: 'V4 Flash',
        vendor: { id: 'deepseek', displayName: 'DeepSeek' },
        capabilities: { ...CAPS },
        pricing: { currency: 'USD', base: { inputPerMTok: 1, outputPerMTok: 2 }, version: 'v1' },
        ...over,
    };
}

function observedProvider(over: Partial<ObservedProvider> = {}): ObservedProvider {
    return {
        id: 'deepseek',
        displayName: 'DeepSeek',
        driverType: 'pi-ai',
        kind: 'official',
        tags: [],
        models: [observedModel()],
        ...over,
    };
}

function observed(providers: ObservedProvider[]): ObservedCatalog {
    return { providers };
}

const DS_OFFERING = offeringIdOf(providerIdOf('deepseek'), modelIdOf('deepseek-v4-flash'));
const OR_OFFERING = offeringIdOf(providerIdOf('openrouter'), modelIdOf('deepseek-v4-flash'));

/** 可变时钟：sync/rebuild 共用同一逻辑时刻，保证快照时间与写入时间一致。 */
const CLOCK = { value: 1000 };
function advance(value: number): number {
    CLOCK.value = value;
    return value;
}

describe('catalog sync：首次入库与幂等', () => {
    it('首次同步建 vendor/provider/model/offering/pricing 并 epoch+1', async () => {
        const service = await CatalogService.open({ store: new MemoryCatalogStore(), now: () => CLOCK.value });
        const result = await service.sync(observed([observedProvider()]), { now: advance(1000) });
        expect(result.changed).toBe(true);
        expect(result.epoch).toBe(1);
        expect(result.changes.map((c) => c.kind)).toEqual([
            'vendor-added',
            'provider-added',
            'model-added',
            'offering-added',
            'pricing-changed',
        ]);
        const snapshot = service.snapshot();
        expect(snapshot.offerings).toHaveLength(1);
        expect(snapshot.offerings[0]?.pricing?.version).toBe('v1');
    });

    it('重复同步相同目录 → 无 diff、epoch 不动（幂等）', async () => {
        const service = await CatalogService.open({ store: new MemoryCatalogStore(), now: () => CLOCK.value });
        await service.sync(observed([observedProvider()]), { now: advance(1000) });
        const second = await service.sync(observed([observedProvider()]), { now: advance(2000) });
        expect(second.changed).toBe(false);
        expect(service.epoch()).toBe(1);
        expect(await service.changesSince(0)).toHaveLength(5);
    });
});

describe('catalog sync：调价追加与回填', () => {
    it('价格变化追加新 plan 并回填旧 plan expiresAt，历史保留', async () => {
        const service = await CatalogService.open({ store: new MemoryCatalogStore(), now: () => CLOCK.value });
        await service.sync(observed([observedProvider()]), { now: advance(1000) });
        const first = service.facts().pricingPlans[0];
        const changed = await service.sync(
            observed([
                observedProvider({
                    models: [
                        observedModel({
                            pricing: {
                                currency: 'USD',
                                base: { inputPerMTok: 2, outputPerMTok: 4 },
                                version: 'v2',
                            },
                        }),
                    ],
                }),
            ]),
            { now: advance(3000) },
        );
        expect(changed.changed).toBe(true);
        const plans = service.facts().pricingPlans;
        expect(plans).toHaveLength(2);
        expect(plans[0]?.id).toBe(first?.id);
        expect(plans[0]?.expiresAt).toBe(3000);
        expect(plans[1]?.version).toBe('v2');
        expect(service.snapshot().offerings[0]?.pricing?.id).toBe(plans[1]?.id);
    });

    it('源不提供价格 → 保持现状，不清空也不虚构', async () => {
        const service = await CatalogService.open({ store: new MemoryCatalogStore(), now: () => CLOCK.value });
        await service.sync(observed([observedProvider()]), { now: advance(1000) });
        const result = await service.sync(
            observed([observedProvider({ models: [observedModel({ pricing: null })] })]),
            { now: advance(2000) },
        );
        expect(result.changed).toBe(false);
        expect(service.facts().pricingPlans).toHaveLength(1);
    });
});

describe('catalog sync：软删与恢复、能力修正', () => {
    it('观测集缺席 → 仅该 provider 的 offering 软删，快照移除', async () => {
        const service = await CatalogService.open({ store: new MemoryCatalogStore(), now: () => CLOCK.value });
        await service.sync(observed([observedProvider()]), { now: advance(1000) });
        const removed = await service.sync(observed([observedProvider({ models: [] })]), { now: advance(2000) });
        expect(removed.changed).toBe(true);
        expect(service.facts().offerings[0]?.status).toBe('deprecated');
        expect(service.snapshot().offerings).toHaveLength(0);
    });

    it('再次观测出现 → offering 恢复 active', async () => {
        const service = await CatalogService.open({ store: new MemoryCatalogStore(), now: () => CLOCK.value });
        await service.sync(observed([observedProvider()]), { now: advance(1000) });
        await service.sync(observed([observedProvider({ models: [] })]), { now: advance(2000) });
        const back = await service.sync(observed([observedProvider()]), { now: advance(3000) });
        expect(back.changes.map((c) => c.kind)).toContain('offering-reactivated');
        expect(service.snapshot().offerings).toHaveLength(1);
    });

    it('厂商静默改规格 → 更新 active 行并留 model-updated 审计', async () => {
        const service = await CatalogService.open({ store: new MemoryCatalogStore(), now: () => CLOCK.value });
        await service.sync(observed([observedProvider()]), { now: advance(1000) });
        const result = await service.sync(
            observed([
                observedProvider({
                    models: [observedModel({ capabilities: { ...CAPS, contextWindow: 256000 } })],
                }),
            ]),
            { now: advance(2000) },
        );
        const update = result.changes.find((c) => c.kind === 'model-updated');
        expect(update?.payload).toEqual({ modelId: 'deepseek-v4-flash', fields: ['capabilities'] });
        expect(service.facts().models[0]?.capabilities.contextWindow).toBe(256000);
    });
});

describe('catalog 路由：能力 / 价格 / 健康 / 迁移链', () => {
    async function twoChannelService(): Promise<CatalogService> {
        const service = await CatalogService.open({ store: new MemoryCatalogStore(), now: () => CLOCK.value });
        await service.sync(
            observed([
                observedProvider(),
                observedProvider({
                    id: 'openrouter',
                    displayName: 'OpenRouter',
                    driverType: 'openai-compat',
                    kind: 'aggregator',
                    models: [observedModel({ capabilitiesOverride: { supportsVision: true } })],
                }),
            ]),
            { now: advance(1000) },
        );
        return service;
    }

    it('默认绑定不可用或能力不符 → 沿迁移链降级', async () => {
        const service = await twoChannelService();
        const driverConfig = {
            id: 'default',
            offeringId: DS_OFFERING,
            fallbackOfferingIds: [OR_OFFERING],
        };
        const direct = routeOffering(service.snapshot(), { driverConfig });
        expect(direct?.view.offering.id).toBe(DS_OFFERING);
        expect(direct?.viaFallback).toBe(false);
        const byCapability = routeOffering(service.snapshot(), {
            driverConfig,
            requiredCapabilities: { supportsVision: true },
        });
        expect(byCapability?.view.offering.id).toBe(OR_OFFERING);
        expect(byCapability?.viaFallback).toBe(true);
        const byHealth = routeOffering(service.snapshot(), {
            driverConfig,
            healthOf: (id) => (id === DS_OFFERING ? 0 : 100),
        });
        expect(byHealth?.view.offering.id).toBe(OR_OFFERING);
    });

    it('全部候选不可用 → null', async () => {
        const service = await twoChannelService();
        const decision = routeOffering(service.snapshot(), {
            driverConfig: { id: 'default', offeringId: DS_OFFERING, fallbackOfferingIds: [OR_OFFERING] },
            requiredCapabilities: { supportsVision: true, maxTokens: 999999 },
        });
        expect(decision).toBeNull();
    });
});

describe('catalog 账本：派发钉死与凭证追加', () => {
    async function serviceWithPricing(): Promise<CatalogService> {
        const service = await CatalogService.open({ store: new MemoryCatalogStore(), now: () => CLOCK.value });
        await service.sync(observed([observedProvider()]), { now: advance(1000) });
        return service;
    }

    it('pin 钉死 plan/epoch；settle 按钉死价目计价且冗余 model/provider', async () => {
        const service = await serviceWithPricing();
        const pin = service.pin(DS_OFFERING);
        expect(pin.catalogEpoch).toBe(1);
        const record = await service.settle(
            pin,
            { inputTokens: 1_000_000, outputTokens: 1_000_000 },
            1500,
        );
        expect(record.cost).toBeCloseTo(3, 10);
        expect(record.modelId).toBe('deepseek-v4-flash');
        expect(record.providerId).toBe('deepseek');
        expect(record.offeringId).toBe(DS_OFFERING);
        expect(record.occurredAt).toBe(1500);
    });

    it('结算用派发时钉死的 plan，后续调价不回改历史', async () => {
        const service = await serviceWithPricing();
        const pin = service.pin(DS_OFFERING);
        await service.sync(
            observed([
                observedProvider({
                    models: [
                        observedModel({
                            pricing: { currency: 'USD', base: { inputPerMTok: 100, outputPerMTok: 100 }, version: 'v2' },
                        }),
                    ],
                }),
            ]),
            { now: advance(2000) },
        );
        const record = await service.settle(pin, { inputTokens: 1_000_000, outputTokens: 0 }, 2500);
        expect(record.pricingPlanId).toBe(pin.pricingPlanId);
        expect(record.cost).toBeCloseTo(1, 10);
        const after = await service.settle(
            service.pin(DS_OFFERING),
            { inputTokens: 1_000_000, outputTokens: 0 },
            2600,
        );
        expect(after.cost).toBeCloseTo(100, 10);
    });

    it('usageSummary 按 offering/model/provider/epoch 聚合', async () => {
        const service = await serviceWithPricing();
        await service.settle(service.pin(DS_OFFERING), { inputTokens: 1_000_000, outputTokens: 0 }, 1);
        await service.settle(service.pin(DS_OFFERING), { inputTokens: 2_000_000, outputTokens: 0 }, 2);
        const summary = await service.usageSummary();
        expect(summary.totals.records).toBe(2);
        expect(summary.totals.inputTokens).toBe(3_000_000);
        expect(summary.totals.cost).toBeCloseTo(3, 10);
        expect(summary.byOffering[0]?.key).toBe(DS_OFFERING);
        expect(summary.byEpoch[0]?.key).toBe(1);
    });

    it('无价供给 pin → 抛错（不产生无凭据请求）', async () => {
        const service = await CatalogService.open({ store: new MemoryCatalogStore(), now: () => CLOCK.value });
        await service.sync(
            observed([observedProvider({ models: [observedModel({ pricing: null })] })]),
            { now: advance(1000) },
        );
        expect(() => service.pin(DS_OFFERING)).toThrow(/no active pricing/);
    });
});

describe('catalog 运维与配置', () => {
    it('setOfferingStatus 软删并记 operator 审计', async () => {
        const service = await CatalogService.open({ store: new MemoryCatalogStore(), now: () => CLOCK.value });
        await service.sync(observed([observedProvider()]), { now: advance(1000) });
        const epoch = await service.setOfferingStatus(DS_OFFERING, 'deprecated');
        expect(epoch).toBe(2);
        expect(service.snapshot().offerings).toHaveLength(0);
        const changes = await service.changesSince(1);
        expect(changes.map((c) => c.kind)).toEqual(['offering-deprecated']);
        expect(changes[0]?.source).toBe('operator');
    });

    it('setDriverConfig 持久化默认绑定与迁移链', async () => {
        const store = new MemoryCatalogStore();
        const service = await CatalogService.open({ store, now: () => CLOCK.value });
        await service.setDriverConfig({
            id: 'default',
            offeringId: DS_OFFERING,
            fallbackOfferingIds: [OR_OFFERING],
        });
        expect(service.driverConfig('default')?.fallbackOfferingIds).toEqual([OR_OFFERING]);
        const reloaded = await CatalogService.open({ store, now: () => CLOCK.value });
        expect(reloaded.driverConfig('default')?.offeringId).toBe(DS_OFFERING);
    });
});

describe('catalog store：文件实现', () => {
    it('facts 原子读写 + usage 追加读回', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-catalog-'));
        try {
            const store = new FileCatalogStore(dir);
            const service = await CatalogService.open({ store, now: () => CLOCK.value });
            await service.sync(observed([observedProvider()]), { now: advance(1000) });
            await service.settle(service.pin(DS_OFFERING), { inputTokens: 10, outputTokens: 5 }, 1200);
            const reopened = await CatalogService.open({ store: new FileCatalogStore(dir), now: () => 2000 });
            expect(reopened.epoch()).toBe(1);
            expect(reopened.snapshot().offerings).toHaveLength(1);
            const records = await reopened.usageRecords();
            expect(records).toHaveLength(1);
            expect(records[0]?.inputTokens).toBe(10);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});