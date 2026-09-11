/**
 * catalog/service —— 目录与账本的组合根（应用层唯一入口）。
 *
 * 职责：持有 CatalogStore 与内存 CatalogRuntime；sync 提交后原子替换快照；
 * 派发钉死 (offeringId, pricingPlanId, epoch)；结算追加 UsageRecord；提供审计查询。
 * 一致性：目录事务 saveFacts 成功后才 rebuild 快照；账本 append 独立，不改历史。
 */

import type {
    CatalogChange,
    CatalogSnapshot,
    DispatchPin,
    DriverConfig,
    HealthSample,
    LifecycleStatus,
    ModelAlias,
    ModelAliasReason,
    ModelId,
    OfferingId,
    UsageRecord,
    UsageTokens,
} from '@mazi/core';
import { findOfferingView, ulid } from '@mazi/core';
import {
    buildUsageRecord,
    filterUsage,
    groupUsageBy,
    type UsageFilter,
    type UsageGroup,
    type UsageTotals,
    usageTotals,
} from './ledger.js';
import { CatalogRuntime } from './snapshot.js';
import type { CatalogFacts } from './state.js';
import { cloneCatalogFacts } from './state.js';
import type { CatalogStore } from './store.js';
import {
    applyCatalogSync,
    type ObservedCatalog,
    type SyncOptions,
    type SyncResult,
} from './sync.js';

export interface CatalogServiceOptions {
    store: CatalogStore;
    now?: () => number;
    id?: () => string;
}

export interface UsageSummary {
    totals: UsageTotals;
    byOffering: UsageGroup[];
    byModel: UsageGroup[];
    byProvider: UsageGroup[];
    byEpoch: UsageGroup[];
}

export interface HealthInput {
    offeringId: OfferingId;
    score: number;
    source?: 'probe' | 'manual-import';
    sampledAt?: number;
}

export class CatalogService {
    private readonly store: CatalogStore;
    private readonly now: () => number;
    private readonly id: () => string;
    private readonly runtime: CatalogRuntime;

    private constructor(
        store: CatalogStore,
        facts: CatalogFacts,
        now: () => number,
        id: () => string,
    ) {
        this.store = store;
        this.now = now;
        this.id = id;
        this.runtime = new CatalogRuntime(facts, now());
    }

    /** 从持久层加载事实并构建首个快照。 */
    static async open(options: CatalogServiceOptions): Promise<CatalogService> {
        const facts = await options.store.loadFacts();
        return new CatalogService(
            options.store,
            facts,
            options.now ?? Date.now,
            options.id ?? (() => ulid()),
        );
    }

    epoch(): number {
        return this.runtime.epoch();
    }

    snapshot(): CatalogSnapshot {
        return this.runtime.current();
    }

    facts(): CatalogFacts {
        return this.runtime.facts();
    }

    /** 应用一次渠道目录同步；有变更才落库并换代。 */
    async sync(observed: ObservedCatalog, options: SyncOptions = {}): Promise<SyncResult> {
        const result = applyCatalogSync(this.runtime.facts(), observed, {
            ...options,
            now: options.now ?? this.now(),
        });
        if (!result.changed) return result;
        await this.store.saveFacts(result.facts);
        this.runtime.rebuild(result.facts, this.now());
        return result;
    }

    driverConfig(id: string): DriverConfig | undefined {
        return this.runtime.facts().driverConfigs.find((config) => config.id === id);
    }

    /** 写入/覆盖默认绑定与迁移链（配置域，持久落库）。 */
    async setDriverConfig(config: DriverConfig): Promise<void> {
        const facts = cloneCatalogFacts(this.runtime.facts());
        const index = facts.driverConfigs.findIndex((item) => item.id === config.id);
        if (index >= 0) facts.driverConfigs[index] = structuredClone(config);
        else facts.driverConfigs.push(structuredClone(config));
        await this.store.saveFacts(facts);
        this.runtime.rebuild(facts, this.now());
    }

    /** 运维下架/恢复供给：软删 + 审计事件 + epoch++。 */
    async setOfferingStatus(offeringId: OfferingId, status: LifecycleStatus): Promise<number> {
        const facts = cloneCatalogFacts(this.runtime.facts());
        const offering = facts.offerings.find((item) => item.id === offeringId);
        if (offering === undefined) {
            throw new Error('catalog.setOfferingStatus: unknown offering ' + offeringId);
        }
        if (offering.status === status) return facts.epoch;
        offering.status = status;
        return this.commitOperatorChange(facts, {
            kind: status === 'active' ? 'offering-reactivated' : 'offering-deprecated',
            payload: { offeringId },
        });
    }

    /** 运维下架/恢复型号（厂商换代：旧 id 软删、alias 解析历史）。 */
    async setModelStatus(modelId: ModelId, status: LifecycleStatus): Promise<number> {
        const facts = cloneCatalogFacts(this.runtime.facts());
        const model = facts.models.find((item) => item.id === modelId);
        if (model === undefined) {
            throw new Error('catalog.setModelStatus: unknown model ' + modelId);
        }
        if (model.status === status) return facts.epoch;
        model.status = status;
        return this.commitOperatorChange(facts, {
            kind: status === 'active' ? 'model-reactivated' : 'model-deprecated',
            payload: { modelId },
        });
    }

    /**
     * 厂商改名/换代：登记 alias，保证旧 UsageRecord 可解析到新 model。
     * 不自动迁移 offering——路由无感由 alias 解析 + 新 model/offering 入库共同保证（设计文档 §10）。
     */
    async createAlias(input: {
        oldModelId: ModelId;
        canonicalModelId: ModelId;
        reason: ModelAliasReason;
    }): Promise<ModelAlias> {
        const facts = cloneCatalogFacts(this.runtime.facts());
        const hasOld = facts.models.some((item) => item.id === input.oldModelId);
        const hasCanonical = facts.models.some((item) => item.id === input.canonicalModelId);
        if (!hasOld || !hasCanonical) {
            throw new Error(
                'catalog.createAlias: both models must exist (' +
                    input.oldModelId +
                    ' → ' +
                    input.canonicalModelId +
                    ')',
            );
        }
        const alias: ModelAlias = {
            id: this.id(),
            oldModelId: input.oldModelId,
            canonicalModelId: input.canonicalModelId,
            reason: input.reason,
            mappedAt: this.now(),
        };
        facts.aliases.push(alias);
        await this.commitOperatorChange(facts, {
            kind: 'alias-created',
            payload: {
                aliasId: alias.id,
                oldModelId: alias.oldModelId,
                canonicalModelId: alias.canonicalModelId,
                reason: alias.reason,
            },
        });
        return alias;
    }

    /** 历史记录解析：旧 model id → 规范 model id；无 alias → 原值。 */
    resolveModelId(modelId: ModelId): ModelId {
        const alias = this.runtime.facts().aliases.find((item) => item.oldModelId === modelId);
        return alias?.canonicalModelId ?? modelId;
    }

    private async commitOperatorChange(
        facts: CatalogFacts,
        change: Pick<CatalogChange, 'kind' | 'payload'>,
    ): Promise<number> {
        const epoch = facts.epoch + 1;
        facts.epoch = epoch;
        facts.changes.push({
            id: this.id(),
            epoch,
            kind: change.kind,
            payload: change.payload,
            source: 'operator',
            occurredAt: this.now(),
        });
        await this.store.saveFacts(facts);
        this.runtime.rebuild(facts, this.now());
        return epoch;
    }

    /** 派发时钉死三元组；无价或不可路由 → 抛错，不产生无凭据请求。 */
    pin(offeringId: OfferingId): DispatchPin {
        const snapshot = this.runtime.current();
        const view = findOfferingView(snapshot, offeringId);
        if (view === null) {
            throw new Error('catalog.pin: offering ' + offeringId + ' is not routable');
        }
        if (view.pricing === null) {
            throw new Error('catalog.pin: offering ' + offeringId + ' has no active pricing plan');
        }
        return {
            offeringId,
            pricingPlanId: view.pricing.id,
            catalogEpoch: snapshot.epoch,
            pinnedAt: this.now(),
        };
    }

    /** 结算：按钉死的 plan 计算成本并追加凭证（append-only，永不改历史）。 */
    async settle(
        pin: DispatchPin,
        tokens: UsageTokens,
        occurredAt: number = this.now(),
    ): Promise<UsageRecord> {
        const facts = this.runtime.facts();
        const plan = facts.pricingPlans.find((item) => item.id === pin.pricingPlanId);
        if (plan === undefined) {
            throw new Error('catalog.settle: pricing plan ' + pin.pricingPlanId + ' not found');
        }
        const offering = facts.offerings.find((item) => item.id === pin.offeringId);
        if (offering === undefined) {
            throw new Error('catalog.settle: offering ' + pin.offeringId + ' not found');
        }
        const record = buildUsageRecord({
            id: this.id(),
            pin,
            offering,
            plan,
            tokens,
            occurredAt,
        });
        await this.store.appendUsage(record);
        return record;
    }

    async usageRecords(filter: UsageFilter = {}): Promise<UsageRecord[]> {
        return filterUsage(await this.store.listUsage(), filter);
    }

    async usageSummary(filter: UsageFilter = {}): Promise<UsageSummary> {
        const records = filterUsage(await this.store.listUsage(), filter);
        return {
            totals: usageTotals(records),
            byOffering: groupUsageBy(records, 'offeringId'),
            byModel: groupUsageBy(records, 'modelId'),
            byProvider: groupUsageBy(records, 'providerId'),
            byEpoch: groupUsageBy(records, 'catalogEpoch'),
        };
    }

    async recordHealth(input: HealthInput): Promise<HealthSample> {
        const sample: HealthSample = {
            id: this.id(),
            offeringId: input.offeringId,
            score: input.score,
            source: input.source ?? 'probe',
            sampledAt: input.sampledAt ?? this.now(),
        };
        await this.store.appendHealth(sample);
        return sample;
    }

    async healthSamples(offeringId?: OfferingId): Promise<HealthSample[]> {
        const samples = await this.store.listHealth();
        return offeringId === undefined
            ? samples
            : samples.filter((sample) => sample.offeringId === offeringId);
    }

    /** 审计：某 epoch 之后的目录变更（用于“epoch N 时系统认为的目录是什么”）。 */
    async changesSince(epoch: number): Promise<CatalogChange[]> {
        return this.runtime.facts().changes.filter((change) => change.epoch > epoch);
    }
}
