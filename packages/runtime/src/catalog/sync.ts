/**
 * catalog/sync —— 目录动态更新管线（写路径）。
 *
 * 入力 = 某次观测到的渠道目录（ObservedCatalog）；与库内 active 目录按 (modelId, providerId) diff，
 * 同事务完成：身份行 upsert / 缺席 offering 软删 / 新 PricingPlan 追加 + 旧行回填 expiresAt /
 * CatalogChange 记录；有变更才 epoch + 1。重复拉到相同目录 → 无 diff → 无写入、epoch 不动（幂等）。
 *
 * 同步范围约定（实施设计 §2）：一次 sync 只对观测集里出现的 provider 权威；未出现的渠道/型号不动，
 * 避免误删运维手工目录。缺失定价 = 保持现状（不为无价型号虚构价格，也不清空已有价格）。
 */

import type {
    CatalogChange,
    CatalogChangeKind,
    CatalogChangeSource,
    ModelCapabilities,
    ModelId,
    OfferingId,
    PricingPlan,
    PricingPlanSource,
    PricingRates,
    PricingTier,
    ProviderId,
    VendorId,
} from '@mazi/core';
import {
    modelIdOf,
    offeringIdOf,
    pricingPlanIdOf,
    providerIdOf,
    selectActivePlan,
    ulid,
    vendorIdOf,
} from '@mazi/core';
import type { CatalogFacts } from './state.js';
import { cloneCatalogFacts } from './state.js';

export interface ObservedVendor {
    id: string;
    displayName?: string;
}

export interface ObservedPricing {
    currency?: string;
    base: PricingRates;
    tiers?: readonly PricingTier[];
    /** 渠道口径生效时刻（epoch ms）；缺省 = 观测时刻 */
    effectiveAt?: number;
    version?: string;
}

export interface ObservedModel {
    id: string;
    name?: string;
    /** 该型号的厂商归属（聚合商一渠道多厂商时逐型号给出） */
    vendor: ObservedVendor;
    capabilities: ModelCapabilities;
    capabilitiesOverride?: Partial<ModelCapabilities> | null;
    /** 缺省/null = 源未提供价格，保持库内现状 */
    pricing?: ObservedPricing | null;
}

export interface ObservedProvider {
    id: string;
    displayName?: string;
    driverType: string;
    kind?: 'official' | 'aggregator' | 'proxy';
    tags?: readonly string[];
    models: readonly ObservedModel[];
}

export interface ObservedCatalog {
    providers: readonly ObservedProvider[];
}

export interface SyncOptions {
    source?: CatalogChangeSource;
    /** 观测时刻（缺省 Date.now） */
    now?: number;
}

export interface SyncResult {
    facts: CatalogFacts;
    /** 同步后的 epoch；无变更时保持原值 */
    epoch: number;
    changed: boolean;
    changes: CatalogChange[];
}

interface PendingChange {
    kind: CatalogChangeKind;
    payload: Record<string, unknown>;
}

function sortedJson(value: unknown): string {
    return JSON.stringify(value);
}

function sameCapabilities(a: ModelCapabilities, b: ModelCapabilities): boolean {
    return (
        a.contextWindow === b.contextWindow &&
        a.maxTokens === b.maxTokens &&
        a.supportsThinking === b.supportsThinking &&
        a.supportsTools === b.supportsTools &&
        a.supportsVision === b.supportsVision
    );
}

function sameRates(a: PricingRates, b: PricingRates): boolean {
    return (
        a.inputPerMTok === b.inputPerMTok &&
        a.outputPerMTok === b.outputPerMTok &&
        (a.cacheReadPerMTok ?? 0) === (b.cacheReadPerMTok ?? 0) &&
        (a.cacheWritePerMTok ?? 0) === (b.cacheWritePerMTok ?? 0)
    );
}

function sameTiers(a: readonly PricingTier[], b: readonly PricingTier[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
        const left = a[i];
        const right = b[i];
        if (left === undefined || right === undefined) return false;
        if (left.thresholdTokens !== right.thresholdTokens) return false;
        if (!sameRates(left.rates, right.rates)) return false;
    }
    return true;
}

/** 校验观测集；非法输入快速失败，不把脏数据写进凭证层。 */
export function validateObservedCatalog(observed: ObservedCatalog): void {
    const providerIds = new Set<string>();
    for (const provider of observed.providers) {
        if (!provider.id) throw new Error('sync: observed provider missing id');
        if (providerIds.has(provider.id)) {
            throw new Error('sync: duplicate observed provider id ' + provider.id);
        }
        providerIds.add(provider.id);
        if (!provider.driverType) {
            throw new Error('sync: provider ' + provider.id + ' missing driverType');
        }
        const modelIds = new Set<string>();
        for (const model of provider.models) {
            if (!model.id)
                throw new Error('sync: provider ' + provider.id + ' has model without id');
            if (modelIds.has(model.id)) {
                throw new Error('sync: provider ' + provider.id + ' duplicate model ' + model.id);
            }
            modelIds.add(model.id);
            if (!model.vendor.id) {
                throw new Error('sync: model ' + model.id + ' missing vendor id');
            }
        }
    }
}

/**
 * 应用一次观测目录同步。纯函数：不读写外部状态，返回新 facts（已 clone）。
 */
export function applyCatalogSync(
    facts: CatalogFacts,
    observed: ObservedCatalog,
    options: SyncOptions = {},
): SyncResult {
    validateObservedCatalog(observed);
    const source: CatalogChangeSource = options.source ?? 'vendor-sync';
    const planSource = pricingSourceOf(source);
    const at = options.now ?? Date.now();
    const next = cloneCatalogFacts(facts);
    const pending: PendingChange[] = [];

    for (const provider of observed.providers) {
        // 先登记该渠道涉及的全部厂商，再登记渠道，保证审计顺序为 vendor → provider。
        const vendorIds = new Map<string, VendorId>();
        for (const model of provider.models) {
            if (!vendorIds.has(model.vendor.id)) {
                vendorIds.set(model.vendor.id, ensureVendor(next, model.vendor, pending));
            }
        }
        const providerId = ensureProvider(next, provider, pending);
        const seen = new Set<string>();
        for (const model of provider.models) {
            const vendorId = vendorIds.get(model.vendor.id);
            if (vendorId === undefined) {
                throw new Error('sync: vendor not registered for model ' + model.id);
            }
            const modelId = ensureModel(next, model, vendorId, pending);
            const offeringId = ensureOffering(next, providerId, modelId, model, pending);
            seen.add(offeringId);
            applyObservedPricing(next, offeringId, model, planSource, at, pending);
        }
        deprecateMissingOfferings(next, providerId, seen, pending);
    }

    if (pending.length === 0) {
        return { facts: next, epoch: next.epoch, changed: false, changes: [] };
    }
    const epoch = next.epoch + 1;
    const changes: CatalogChange[] = pending.map((change) => ({
        id: ulid(),
        epoch,
        kind: change.kind,
        payload: change.payload,
        source,
        occurredAt: at,
    }));
    next.epoch = epoch;
    next.changes.push(...changes);
    return { facts: next, epoch, changed: true, changes };
}

function ensureVendor(
    next: CatalogFacts,
    vendor: ObservedVendor,
    pending: PendingChange[],
): VendorId {
    const id = vendorIdOf(vendor.id);
    const existing = next.vendors.find((item) => item.id === id);
    if (existing === undefined) {
        const displayName = vendor.displayName ?? vendor.id;
        next.vendors.push({ id, displayName, status: 'active' });
        pending.push({ kind: 'vendor-added', payload: { vendorId: vendor.id, displayName } });
        return id;
    }
    if (existing.status !== 'active') {
        existing.status = 'active';
        pending.push({ kind: 'vendor-added', payload: { vendorId: vendor.id, reactivated: true } });
    }
    if (vendor.displayName !== undefined && existing.displayName !== vendor.displayName) {
        existing.displayName = vendor.displayName;
        pending.push({
            kind: 'operator-override',
            payload: { vendorId: vendor.id, displayName: vendor.displayName },
        });
    }
    return id;
}

function ensureProvider(
    next: CatalogFacts,
    provider: ObservedProvider,
    pending: PendingChange[],
): ProviderId {
    const id = providerIdOf(provider.id);
    const existing = next.providers.find((item) => item.id === id);
    if (existing === undefined) {
        const displayName = provider.displayName ?? provider.id;
        next.providers.push({
            id,
            displayName,
            driverType: provider.driverType,
            ...(provider.kind !== undefined ? { kind: provider.kind } : {}),
            tags: [...(provider.tags ?? [])],
            status: 'active',
        });
        pending.push({ kind: 'provider-added', payload: { providerId: provider.id } });
        return id;
    }
    if (existing.status !== 'active') {
        existing.status = 'active';
        pending.push({
            kind: 'provider-added',
            payload: { providerId: provider.id, reactivated: true },
        });
    }
    const updated: string[] = [];
    if (provider.displayName !== undefined && existing.displayName !== provider.displayName) {
        existing.displayName = provider.displayName;
        updated.push('displayName');
    }
    if (existing.driverType !== provider.driverType) {
        existing.driverType = provider.driverType;
        updated.push('driverType');
    }
    if (provider.kind !== undefined && existing.kind !== provider.kind) {
        existing.kind = provider.kind;
        updated.push('kind');
    }
    if (provider.tags !== undefined && sortedJson(existing.tags) !== sortedJson(provider.tags)) {
        existing.tags = [...provider.tags];
        updated.push('tags');
    }
    if (updated.length > 0) {
        pending.push({
            kind: 'provider-updated',
            payload: { providerId: provider.id, fields: updated },
        });
    }
    return id;
}

function ensureModel(
    next: CatalogFacts,
    model: ObservedModel,
    vendorId: VendorId,
    pending: PendingChange[],
): ModelId {
    const id = modelIdOf(model.id);
    const existing = next.models.find((item) => item.id === id);
    if (existing === undefined) {
        next.models.push({
            id,
            vendorId,
            name: model.name ?? model.id,
            capabilities: { ...model.capabilities },
            status: 'active',
        });
        pending.push({
            kind: 'model-added',
            payload: { modelId: model.id, vendorId: model.vendor.id },
        });
        return id;
    }
    if (existing.status !== 'active') {
        existing.status = 'active';
        pending.push({ kind: 'model-reactivated', payload: { modelId: model.id } });
    }
    const updated: string[] = [];
    if (existing.vendorId !== vendorId) {
        existing.vendorId = vendorId;
        updated.push('vendorId');
    }
    if (model.name !== undefined && existing.name !== model.name) {
        existing.name = model.name;
        updated.push('name');
    }
    if (!sameCapabilities(existing.capabilities, model.capabilities)) {
        existing.capabilities = { ...model.capabilities };
        updated.push('capabilities');
    }
    if (updated.length > 0) {
        pending.push({ kind: 'model-updated', payload: { modelId: model.id, fields: updated } });
    }
    return id;
}

function ensureOffering(
    next: CatalogFacts,
    providerId: ProviderId,
    modelId: ModelId,
    model: ObservedModel,
    pending: PendingChange[],
): OfferingId {
    const id = offeringIdOf(providerId, modelId);
    const existing = next.offerings.find((item) => item.id === id);
    const desiredOverride = model.capabilitiesOverride ?? null;
    if (existing === undefined) {
        next.offerings.push({
            id,
            modelId,
            providerId,
            capabilitiesOverride: desiredOverride,
            status: 'active',
        });
        pending.push({
            kind: 'offering-added',
            payload: { offeringId: id, providerId, modelId },
        });
        return id;
    }
    if (existing.status !== 'active') {
        existing.status = 'active';
        pending.push({ kind: 'offering-reactivated', payload: { offeringId: id } });
    }
    if (sortedJson(existing.capabilitiesOverride) !== sortedJson(desiredOverride)) {
        existing.capabilitiesOverride = desiredOverride;
        pending.push({
            kind: 'offering-updated',
            payload: { offeringId: id, field: 'capabilitiesOverride' },
        });
    }
    return id;
}

function pricingSourceOf(source: CatalogChangeSource): PricingPlanSource {
    if (source === 'operator') return 'operator';
    if (source === 'manual-import') return 'manual-import';
    return 'vendor-sync';
}

function applyObservedPricing(
    next: CatalogFacts,
    offeringId: OfferingId,
    model: ObservedModel,
    source: PricingPlanSource,
    at: number,
    pending: PendingChange[],
): void {
    const pricing = model.pricing;
    if (pricing === null || pricing === undefined) return;
    const tiers = pricing.tiers ?? [];
    const currency = pricing.currency ?? 'USD';
    const current = selectActivePlan(next.pricingPlans, offeringId, at);
    if (
        current !== null &&
        current.currency === currency &&
        sameRates(current.base, pricing.base) &&
        sameTiers(current.tiers, tiers)
    ) {
        return;
    }
    const effectiveAt = pricing.effectiveAt ?? at;
    const plan: PricingPlan = {
        id: pricingPlanIdOf(ulid()),
        offeringId,
        currency,
        base: { ...pricing.base },
        tiers: tiers.map((tier) => ({
            thresholdTokens: tier.thresholdTokens,
            rates: { ...tier.rates },
        })),
        effectiveAt,
        expiresAt: null,
        observedAt: at,
        source,
        version: pricing.version ?? 'sync',
    };
    if (current !== null && current.expiresAt === null && effectiveAt >= current.effectiveAt) {
        current.expiresAt = effectiveAt;
    }
    next.pricingPlans.push(plan);
    pending.push({
        kind: 'pricing-changed',
        payload: {
            offeringId,
            fromPlanId: current?.id ?? null,
            toPlanId: plan.id,
            effectiveAt,
        },
    });
}

function deprecateMissingOfferings(
    next: CatalogFacts,
    providerId: ProviderId,
    seen: ReadonlySet<string>,
    pending: PendingChange[],
): void {
    for (const offering of next.offerings) {
        if (offering.providerId !== providerId) continue;
        if (offering.status !== 'active') continue;
        if (seen.has(offering.id)) continue;
        offering.status = 'deprecated';
        pending.push({ kind: 'offering-deprecated', payload: { offeringId: offering.id } });
    }
}
