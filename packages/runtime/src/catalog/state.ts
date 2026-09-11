/**
 * catalog/state —— 目录事实层（长期凭证）的内存表示。
 * 目录身份行可 upsert/软删；PricingPlan 追加 + 回填 expiresAt；changes 随事务写入。
 * usage_records / health_samples 为独立 append-only，不在此结构内。
 */

import type {
    CatalogChange,
    DriverConfig,
    Model,
    ModelAlias,
    Offering,
    PricingPlan,
    Provider,
    Vendor,
} from '@mazi/core';

export interface CatalogFacts {
    /** 单调递增快照版本；目录事务提交时 +1 */
    epoch: number;
    vendors: Vendor[];
    providers: Provider[];
    models: Model[];
    offerings: Offering[];
    /** 追加式价格版本链；仅允许回填 expiresAt，永不 UPDATE/DELETE 价格 */
    pricingPlans: PricingPlan[];
    aliases: ModelAlias[];
    driverConfigs: DriverConfig[];
    /** 审计事件；与目录写入同事务 */
    changes: CatalogChange[];
}

export function emptyCatalogFacts(): CatalogFacts {
    return {
        epoch: 0,
        vendors: [],
        providers: [],
        models: [],
        offerings: [],
        pricingPlans: [],
        aliases: [],
        driverConfigs: [],
        changes: [],
    };
}

/** 深拷贝事实，保证调用方拿到的不是内部可变引用。 */
export function cloneCatalogFacts(facts: CatalogFacts): CatalogFacts {
    return structuredClone(facts);
}
