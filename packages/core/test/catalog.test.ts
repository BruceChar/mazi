import { describe, expect, it } from 'vitest';
import type {
    CatalogSnapshotInput,
    Model,
    ModelCapabilities,
    Offering,
    PricingPlan,
    Provider,
    Vendor,
} from '../src/catalog.js';
import {
    buildCatalogSnapshot,
    capabilitySatisfies,
    findOfferingView,
    mergeCapabilities,
    modelIdOf,
    offeringIdOf,
    offeringViewsByModel,
    priceUsage,
    pricingPlanIdOf,
    providerIdOf,
    rateCardFor,
    selectActivePlan,
    vendorIdOf,
} from '../src/catalog.js';

const VENDOR = vendorIdOf('deepseek');
const PROVIDER = providerIdOf('deepseek');
const OTHER_PROVIDER = providerIdOf('openrouter');
const MODEL = modelIdOf('deepseek-v4-flash');
const OFFERING = offeringIdOf(PROVIDER, MODEL);

const CAPS: ModelCapabilities = {
    contextWindow: 128000,
    maxTokens: 8192,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: false,
};

function vendor(over: Partial<Vendor> = {}): Vendor {
    return { id: VENDOR, displayName: 'DeepSeek', status: 'active', ...over };
}
function provider(over: Partial<Provider> = {}): Provider {
    return {
        id: PROVIDER,
        displayName: 'DeepSeek Official',
        driverType: 'pi-ai',
        kind: 'official',
        tags: [],
        status: 'active',
        ...over,
    };
}
function model(over: Partial<Model> = {}): Model {
    return { id: MODEL, vendorId: VENDOR, name: 'V4 Flash', capabilities: CAPS, status: 'active', ...over };
}
function offering(over: Partial<Offering> = {}): Offering {
    return { id: OFFERING, modelId: MODEL, providerId: PROVIDER, capabilitiesOverride: null, status: 'active', ...over };
}
function plan(over: Partial<PricingPlan> = {}): PricingPlan {
    return {
        id: pricingPlanIdOf('plan-1'),
        offeringId: OFFERING,
        currency: 'USD',
        base: { inputPerMTok: 1, outputPerMTok: 2 },
        tiers: [],
        effectiveAt: 1000,
        expiresAt: null,
        observedAt: 1000,
        source: 'vendor-sync',
        version: 'v1',
        ...over,
    };
}

describe('catalog 契约：品牌 id 与 offering 生成', () => {
    it('offeringIdOf 采用 provider/model 约定', () => {
        expect(offeringIdOf(PROVIDER, MODEL)).toBe('deepseek/deepseek-v4-flash');
    });
});

describe('catalog 纯函数：能力合成与过滤', () => {
    it('mergeCapabilities 无 override 时复制厂商规格', () => {
        expect(mergeCapabilities(CAPS, null)).toEqual(CAPS);
        expect(mergeCapabilities(CAPS, null)).not.toBe(CAPS);
    });
    it('mergeCapabilities 用渠道 override 覆盖单字段', () => {
        expect(mergeCapabilities(CAPS, { supportsVision: true }).supportsVision).toBe(true);
        expect(mergeCapabilities(CAPS, { supportsVision: true }).supportsTools).toBe(true);
    });
    it('capabilitySatisfies：boolean 必须为真，number 必须 >=', () => {
        expect(capabilitySatisfies(CAPS, { supportsTools: true })).toBe(true);
        expect(capabilitySatisfies(CAPS, { supportsVision: true })).toBe(false);
        expect(capabilitySatisfies(CAPS, { contextWindow: 64000 })).toBe(true);
        expect(capabilitySatisfies(CAPS, { contextWindow: 256000 })).toBe(false);
        expect(capabilitySatisfies(CAPS, undefined)).toBe(true);
    });
});

describe('catalog 纯函数：价格链选择', () => {
    it('仅在 [effectiveAt, expiresAt) 生效', () => {
        const p = plan({ effectiveAt: 100, expiresAt: 200 });
        expect(selectActivePlan([p], OFFERING, 99)).toBeNull();
        expect(selectActivePlan([p], OFFERING, 100)).toBe(p);
        expect(selectActivePlan([p], OFFERING, 199)).toBe(p);
        expect(selectActivePlan([p], OFFERING, 200)).toBeNull();
    });
    it('取最新 effectiveAt；重叠时 operator 优先', () => {
        const older = plan({ id: pricingPlanIdOf('a'), effectiveAt: 100 });
        const newer = plan({ id: pricingPlanIdOf('b'), effectiveAt: 200 });
        expect(selectActivePlan([older, newer], OFFERING, 300)?.id).toBe('b');
        const sync = plan({ id: pricingPlanIdOf('s'), effectiveAt: 200, source: 'vendor-sync' });
        const op = plan({ id: pricingPlanIdOf('o'), effectiveAt: 200, source: 'operator' });
        expect(selectActivePlan([sync, op], OFFERING, 300)?.id).toBe('o');
    });
    it('忽略其他 offering 的计划', () => {
        const foreign = plan({ offeringId: offeringIdOf(OTHER_PROVIDER, MODEL) });
        expect(selectActivePlan([foreign], OFFERING, 1000)).toBeNull();
    });
});

describe('catalog 纯函数：费率卡与计价', () => {
    it('rateCardFor 选最大 thresholdTokens <= inputTokens，否则 base', () => {
        const p = plan({
            tiers: [
                { thresholdTokens: 32000, rates: { inputPerMTok: 2, outputPerMTok: 4 } },
                { thresholdTokens: 128000, rates: { inputPerMTok: 4, outputPerMTok: 8 } },
            ],
        });
        expect(rateCardFor(p, 1000).thresholdTokens).toBeNull();
        expect(rateCardFor(p, 32000).rates.inputPerMTok).toBe(2);
        expect(rateCardFor(p, 127999).rates.inputPerMTok).toBe(2);
        expect(rateCardFor(p, 128000).rates.inputPerMTok).toBe(4);
    });
    it('priceUsage：input 扣除 cacheRead 后单独计价，缓存单独计价', () => {
        const p = plan({
            base: { inputPerMTok: 1, outputPerMTok: 3, cacheReadPerMTok: 0.1, cacheWritePerMTok: 5 },
        });
        const cost = priceUsage(
            { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 400_000, cacheWriteTokens: 100_000 },
            p,
        );
        expect(cost.inputCostUsd).toBeCloseTo(0.6, 10);
        expect(cost.cacheReadCostUsd).toBeCloseTo(0.04, 10);
        expect(cost.cacheWriteCostUsd).toBeCloseTo(0.5, 10);
        expect(cost.outputCostUsd).toBeCloseTo(3, 10);
        expect(cost.totalCostUsd).toBeCloseTo(4.14, 10);
        expect(cost.pricingPlanId).toBe('plan-1');
        expect(cost.appliedTierThreshold).toBeNull();
    });
    it('priceUsage：缺失缓存价按 0，不虚构', () => {
        const p = plan({ base: { inputPerMTok: 1, outputPerMTok: 1 } });
        const cost = priceUsage({ inputTokens: 100, outputTokens: 100, cacheReadTokens: 50 }, p);
        expect(cost.cacheReadCostUsd).toBe(0);
    });
});

describe('catalog 纯函数：快照构建', () => {
    function input(over: Partial<CatalogSnapshotInput> = {}): CatalogSnapshotInput {
        return {
            epoch: 1,
            vendors: [vendor()],
            providers: [provider()],
            models: [model()],
            offerings: [offering()],
            pricingPlans: [plan()],
            ...over,
        };
    }
    it('仅保留三方均 active 的 offering，并挂上生效价目', () => {
        const snap = buildCatalogSnapshot(input(), 2000);
        expect(snap.epoch).toBe(1);
        expect(snap.offerings).toHaveLength(1);
        expect(snap.offerings[0]?.pricing?.id).toBe('plan-1');
    });
    it('无价目 → pricing=null（目录可见但不可路由）', () => {
        const snap = buildCatalogSnapshot(input({ pricingPlans: [] }), 2000);
        expect(snap.offerings[0]?.pricing).toBeNull();
    });
    it('任一实体 inactive → 快照移除', () => {
        expect(buildCatalogSnapshot(input({ models: [model({ status: 'deprecated' })] }), 2000).offerings).toHaveLength(0);
        expect(buildCatalogSnapshot(input({ providers: [provider({ status: 'offline' })] }), 2000).offerings).toHaveLength(0);
        expect(buildCatalogSnapshot(input({ offerings: [offering({ status: 'deprecated' })] }), 2000).offerings).toHaveLength(0);
    });
    it('effectiveCapabilities 合成渠道 override', () => {
        const snap = buildCatalogSnapshot(
            input({ offerings: [offering({ capabilitiesOverride: { supportsVision: true } })] }),
            2000,
        );
        expect(snap.offerings[0]?.effectiveCapabilities.supportsVision).toBe(true);
    });
    it('findOfferingView / offeringViewsByModel 定位供给', () => {
        const snap = buildCatalogSnapshot(input(), 2000);
        expect(findOfferingView(snap, OFFERING)?.offering.id).toBe(OFFERING);
        expect(findOfferingView(snap, offeringIdOf(OTHER_PROVIDER, MODEL))).toBeNull();
        expect(offeringViewsByModel(snap, MODEL)).toHaveLength(1);
    });
});
