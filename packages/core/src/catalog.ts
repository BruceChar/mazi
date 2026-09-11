/**
 * catalog —— 模型目录与计费数据架构契约（docs/模型目录与计费数据架构设计文档.md §4）。
 *
 * 五层概念模型：vendor（谁开发） → model（什么型号） → provider（从哪个渠道接）
 * → offering（该渠道×该型号的具体供给） → driver 协议（渠道用什么协议说话）。
 * 定价 / 健康 / 能力偏差 / 用量账本的统一挂靠点都在 offering。
 *
 * 本文件是**纯契约 + 纯函数**：零 IO、零存储、零厂商 SDK 依赖。
 * 所有时间戳统一为 epoch 毫秒 number（仓库既有约定；JSON 往返无损，见实施设计 §2）。
 * 实现与文档不一致时，以本文档与设计文档为准并同步修正。
 */

// ============================================================
// 1. 基础：生命周期与品牌 id
// ============================================================

/** 目录数据永不物理删除：下架 = 状态标记，身份保留作为历史引用的锚点。 */
export type LifecycleStatus = 'active' | 'deprecated' | 'offline';

declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

export type VendorId = Brand<string, 'Vendor'>;
export type ProviderId = Brand<string, 'Provider'>;
export type ModelId = Brand<string, 'Model'>;
export type OfferingId = Brand<string, 'Offering'>;
export type PricingPlanId = Brand<string, 'PricingPlan'>;

/** branded 类型是 string，但不可互换、不可裸写；统一经下列构造器创建。 */
export const vendorIdOf = (id: string): VendorId => id as VendorId;
export const providerIdOf = (id: string): ProviderId => id as ProviderId;
export const modelIdOf = (id: string): ModelId => id as ModelId;
export const pricingPlanIdOf = (id: string): PricingPlanId => id as PricingPlanId;

/** offering 天然键 (modelId, providerId)；id 采用 `${providerId}/${modelId}` 生成约定，肉眼可读。 */
export function offeringIdOf(providerId: ProviderId, modelId: ModelId): OfferingId {
    return `${providerId}/${modelId}` as OfferingId;
}

// ============================================================
// 2. 目录域
// ============================================================

export interface Vendor {
    id: VendorId;
    displayName: string;
    status: LifecycleStatus;
}

export interface Provider {
    id: ProviderId;
    displayName: string;
    /** 渠道端点使用的协议适配器 —— 承接源 JSON 的 driver.type */
    driverType: string;
    /** 渠道性质，路由权重参考：官方直连 / 聚合商 / 代理 */
    kind?: 'official' | 'aggregator' | 'proxy';
    tags: readonly string[];
    status: LifecycleStatus;
}

/** 厂商规格：能力与型号同生共死，是唯一适合嵌入 Model 的部分。 */
export interface ModelCapabilities {
    contextWindow: number;
    maxTokens: number;
    supportsThinking: boolean;
    supportsTools: boolean;
    supportsVision: boolean;
}

export interface Model {
    id: ModelId;
    /** 谁开发的（vendor 挂在 Model 上，不挂在 Provider 上） */
    vendorId: VendorId;
    name: string;
    capabilities: ModelCapabilities;
    status: LifecycleStatus;
}

/**
 * Offering：可购买单元 = model × provider。
 * capabilitiesOverride = 渠道对厂商规格的偏差；null = 完全遵循厂商规格。
 */
export interface Offering {
    id: OfferingId;
    modelId: ModelId;
    providerId: ProviderId;
    capabilitiesOverride: Partial<ModelCapabilities> | null;
    status: LifecycleStatus;
}

export type ModelAliasReason = 'vendor-rename' | 'operator-merge';

/** 厂商改名/换代：旧 id 软删，新 id 插入，alias 保证历史记录可解析。 */
export interface ModelAlias {
    id: string;
    oldModelId: ModelId;
    canonicalModelId: ModelId;
    reason: ModelAliasReason;
    mappedAt: number;
}

// ============================================================
// 3. 商业域：定价版本链（挂 offering）
// ============================================================

export interface PricingRates {
    inputPerMTok: number;
    outputPerMTok: number;
    /** 渠道未披露缓存价 → undefined（按 0 计，不虚构价格） */
    cacheReadPerMTok?: number;
    cacheWritePerMTok?: number;
}

/** 长上下文加价档：命中档位的 rates 整体替换 base（按输入 token 数选择，见实施设计 §2）。 */
export interface PricingTier {
    thresholdTokens: number;
    rates: PricingRates;
}

export type PricingPlanSource = 'vendor-sync' | 'operator' | 'manual-import';

/** 价格调整 = 插入新行 + 回填旧行 expiresAt，永不 UPDATE 价格、永不 DELETE。 */
export interface PricingPlan {
    id: PricingPlanId;
    offeringId: OfferingId;
    currency: string;
    base: PricingRates;
    tiers: readonly PricingTier[];
    /** 渠道口径的生效时刻（epoch ms） */
    effectiveAt: number;
    /** null = 当前生效；新版本插入时回填 */
    expiresAt: number | null;
    /** 我们何时得知（epoch ms）——与 effectiveAt 差值即「迟知成本」 */
    observedAt: number;
    source: PricingPlanSource;
    version: string;
}

// ============================================================
// 4. 观测域：健康时序（挂 offering）
// ============================================================

export interface HealthSample {
    id: string;
    offeringId: OfferingId;
    score: number;
    source: 'probe' | 'manual-import';
    sampledAt: number;
}

// ============================================================
// 5. 配置域：默认绑定与迁移链
// ============================================================

export interface DriverConfig {
    id: string;
    /** 默认绑定：钉到具体 offering（渠道×型号），而非裸 model id */
    offeringId: OfferingId;
    /** 迁移链，按优先级排序；约定：同型号换渠道优先，跨型号兜底 */
    fallbackOfferingIds: readonly OfferingId[];
}

// ============================================================
// 6. 账本域：长期凭证的落点（挂 offering）
// ============================================================

export interface UsageTokens {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
}

export interface UsageRecord {
    id: string;
    /** 结算主体：哪个渠道的哪个型号 */
    offeringId: OfferingId;
    /** 冗余列：报表按型号聚合免 join */
    modelId: ModelId;
    /** 冗余列：报表按渠道聚合 */
    providerId: ProviderId;
    /** 派发时刻钉死，结算依据（非实时价格） */
    pricingPlanId: PricingPlanId;
    /** 由哪个快照版本路由，可追溯到变更审计 */
    catalogEpoch: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    /** 冗余存结果，账务可审计 */
    cost: number;
    currency: string;
    occurredAt: number;
}

/** 派发时刻从快照钉死的三元组；飞行途中价格/下架与本请求无关。 */
export interface DispatchPin {
    offeringId: OfferingId;
    pricingPlanId: PricingPlanId;
    catalogEpoch: number;
    pinnedAt: number;
}

// ============================================================
// 7. 审计域：目录变更事件
// ============================================================

export type CatalogChangeKind =
    | 'vendor-added'
    | 'provider-added'
    | 'provider-deprecated'
    | 'provider-updated'
    | 'model-added'
    | 'model-updated'
    | 'model-deprecated'
    | 'model-reactivated'
    | 'offering-added'
    | 'offering-updated'
    | 'offering-deprecated'
    | 'offering-reactivated'
    | 'pricing-changed'
    | 'operator-override'
    | 'alias-created';

export type CatalogChangeSource = 'vendor-sync' | 'operator' | 'probe' | 'user' | 'manual-import';

export interface CatalogChange {
    id: string;
    /** 单调递增，快照版本号；同一目录事务的多条 change 共享同一 epoch */
    epoch: number;
    kind: CatalogChangeKind;
    /** diff 形态，只存变化 */
    payload: Record<string, unknown>;
    source: CatalogChangeSource;
    occurredAt: number;
}

// ============================================================
// 8. 运行时层：快照（内存结构，不落库）
// ============================================================

export interface ActiveOfferingView {
    offering: Offering;
    model: Model;
    provider: Provider;
    /** 合成后能力 = 厂商规格 ⊕ 渠道 override，路由判断只看这一个 */
    effectiveCapabilities: ModelCapabilities;
    /** 当前生效价目；null = 目录可见但不可路由（无价不可结算） */
    pricing: PricingPlan | null;
}

export interface CatalogSnapshot {
    epoch: number;
    builtAt: number;
    /** 仅 status=active（且 model/provider 均 active）的供给 */
    offerings: readonly ActiveOfferingView[];
}

/** buildCatalogSnapshot 的输入（目录事实的只读视图）。 */
export interface CatalogSnapshotInput {
    epoch: number;
    vendors: readonly Vendor[];
    providers: readonly Provider[];
    models: readonly Model[];
    offerings: readonly Offering[];
    pricingPlans: readonly PricingPlan[];
}

// ============================================================
// 9. 纯函数：能力合成
// ============================================================

/** 合成后能力 = 厂商规格 ⊕ 渠道 override；override 的键覆盖厂商值。 */
export function mergeCapabilities(
    base: ModelCapabilities,
    override: Partial<ModelCapabilities> | null | undefined,
): ModelCapabilities {
    if (override === null || override === undefined) {
        return { ...base };
    }
    return { ...base, ...override };
}

/** required 中每个键：boolean 要求至少相等（true→true），number 要求 >=。 */
export function capabilitySatisfies(
    capabilities: ModelCapabilities,
    required: Partial<ModelCapabilities> | undefined,
): boolean {
    if (required === undefined) return true;
    for (const key of Object.keys(required) as Array<keyof ModelCapabilities>) {
        const want = required[key];
        if (want === undefined) continue;
        const have = capabilities[key];
        if (typeof want === 'boolean') {
            if (want && have !== true) return false;
        } else if (typeof have === 'number' && have < (want as number)) {
            return false;
        }
    }
    return true;
}

// ============================================================
// 10. 纯函数：定价版本链选择与计价
// ============================================================

/** 计划在 at 时刻是否生效：[effectiveAt, expiresAt)。 */
export function isPlanActive(plan: PricingPlan, at: number): boolean {
    return plan.effectiveAt <= at && (plan.expiresAt === null || plan.expiresAt > at);
}

/** 同 effectiveAt 冲突时来源优先级：operator 覆盖渠道，其次人工导入，最后 sync。 */
const PRICING_SOURCE_PRIORITY: Record<PricingPlanSource, number> = {
    operator: 2,
    'manual-import': 1,
    'vendor-sync': 0,
};

function isBetterPlan(candidate: PricingPlan, current: PricingPlan): boolean {
    if (candidate.effectiveAt !== current.effectiveAt) {
        return candidate.effectiveAt > current.effectiveAt;
    }
    const bySource =
        PRICING_SOURCE_PRIORITY[candidate.source] - PRICING_SOURCE_PRIORITY[current.source];
    if (bySource !== 0) return bySource > 0;
    return candidate.id > current.id;
}

/** 取该 offering 在 at 时刻生效的价目；无 → null（不可路由）。 */
export function selectActivePlan(
    plans: readonly PricingPlan[],
    offeringId: OfferingId,
    at: number,
): PricingPlan | null {
    let best: PricingPlan | null = null;
    for (const plan of plans) {
        if (plan.offeringId !== offeringId) continue;
        if (!isPlanActive(plan, at)) continue;
        if (best === null || isBetterPlan(plan, best)) best = plan;
    }
    return best;
}

export interface RateCardSelection {
    rates: PricingRates;
    /** 命中的档位阈值；null = base */
    thresholdTokens: number | null;
}

/** 按输入 token 数选择费率卡：最大 thresholdTokens <= inputTokens，否则 base。 */
export function rateCardFor(plan: PricingPlan, inputTokens: number): RateCardSelection {
    let chosen: PricingTier | null = null;
    for (const tier of plan.tiers) {
        if (tier.thresholdTokens > inputTokens) continue;
        if (chosen === null || tier.thresholdTokens > chosen.thresholdTokens) chosen = tier;
    }
    return chosen === null
        ? { rates: plan.base, thresholdTokens: null }
        : { rates: chosen.rates, thresholdTokens: chosen.thresholdTokens };
}

export interface UsageCost {
    inputCostUsd: number;
    outputCostUsd: number;
    cacheReadCostUsd: number;
    cacheWriteCostUsd: number;
    totalCostUsd: number;
    currency: string;
    pricingPlanId: PricingPlanId;
    pricingVersion: string;
    /** 命中的档位阈值；null = base */
    appliedTierThreshold: number | null;
}

const PER_MILLION = 1_000_000;

/**
 * 按钉死的价目计算一次调用的成本。
 * input 计量 = inputTokens − cacheReadTokens（缓存命中单独计价，避免双计）；
 * cacheWrite 为独立量；缺失价率按 0。
 */
export function priceUsage(tokens: UsageTokens, plan: PricingPlan): UsageCost {
    const cacheRead = tokens.cacheReadTokens ?? 0;
    const cacheWrite = tokens.cacheWriteTokens ?? 0;
    const card = rateCardFor(plan, tokens.inputTokens);
    const inputUnits = Math.max(tokens.inputTokens - cacheRead, 0);
    const inputCostUsd = (inputUnits * card.rates.inputPerMTok) / PER_MILLION;
    const outputCostUsd = (tokens.outputTokens * card.rates.outputPerMTok) / PER_MILLION;
    const cacheReadCostUsd = (cacheRead * (card.rates.cacheReadPerMTok ?? 0)) / PER_MILLION;
    const cacheWriteCostUsd = (cacheWrite * (card.rates.cacheWritePerMTok ?? 0)) / PER_MILLION;
    return {
        inputCostUsd,
        outputCostUsd,
        cacheReadCostUsd,
        cacheWriteCostUsd,
        totalCostUsd: inputCostUsd + outputCostUsd + cacheReadCostUsd + cacheWriteCostUsd,
        currency: plan.currency,
        pricingPlanId: plan.id,
        pricingVersion: plan.version,
        appliedTierThreshold: card.thresholdTokens,
    };
}

// ============================================================
// 11. 纯函数：快照构建与查询
// ============================================================

/** 整体构建 CatalogSnapshot：仅保留三方均 active 的 offering；无价则 pricing=null。 */
export function buildCatalogSnapshot(input: CatalogSnapshotInput, at: number): CatalogSnapshot {
    const vendors = new Map(input.vendors.map((v) => [v.id, v]));
    const providers = new Map(input.providers.map((p) => [p.id, p]));
    const models = new Map(input.models.map((m) => [m.id, m]));

    const views: ActiveOfferingView[] = [];
    for (const offering of input.offerings) {
        if (offering.status !== 'active') continue;
        const provider = providers.get(offering.providerId);
        const model = models.get(offering.modelId);
        if (provider === undefined || provider.status !== 'active') continue;
        if (model === undefined || model.status !== 'active') continue;
        if (vendors.get(model.vendorId)?.status !== 'active') continue;
        views.push({
            offering,
            model,
            provider,
            effectiveCapabilities: mergeCapabilities(
                model.capabilities,
                offering.capabilitiesOverride,
            ),
            pricing: selectActivePlan(input.pricingPlans, offering.id, at),
        });
    }
    views.sort((a, b) =>
        a.offering.id < b.offering.id ? -1 : a.offering.id > b.offering.id ? 1 : 0,
    );
    return { epoch: input.epoch, builtAt: at, offerings: views };
}

/** 在快照中查找供给视图；不存在 → null。 */
export function findOfferingView(
    snapshot: CatalogSnapshot,
    offeringId: OfferingId,
): ActiveOfferingView | null {
    for (const view of snapshot.offerings) {
        if (view.offering.id === offeringId) return view;
    }
    return null;
}

/** 在快照中取某型号的全部 active 供给（用于同型号换渠道 fallback 提示）。 */
export function offeringViewsByModel(
    snapshot: CatalogSnapshot,
    modelId: ModelId,
): ActiveOfferingView[] {
    return snapshot.offerings.filter((view) => view.model.id === modelId);
}
