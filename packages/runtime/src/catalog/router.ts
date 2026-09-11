/**
 * catalog/router —— 基于快照的路由决策（纯查询，无副作用）。
 * 输入 DriverConfig 默认绑定 + 迁移链；按能力 / 价格 / 健康过滤，返回首个可用供给。
 * 同型号换渠道优先由 fallbackOfferingIds 的顺序表达（运维/配置负责排序）。
 */

import type {
    ActiveOfferingView,
    CatalogSnapshot,
    DriverConfig,
    ModelCapabilities,
    OfferingId,
} from '@mazi/core';
import { capabilitySatisfies, findOfferingView } from '@mazi/core';

export interface CatalogRouteRequest {
    driverConfig: DriverConfig;
    /** 能力硬过滤（如必须支持 tools/vision） */
    requiredCapabilities?: Partial<ModelCapabilities>;
    /** 健康查询（缺省不过滤健康）；返回 0-100 */
    healthOf?: (offeringId: OfferingId) => number;
    /** 低于该健康分剔除；缺省 1（0 = 硬摘除） */
    minHealth?: number;
    /** 无价不可结算；缺省 true */
    requirePricing?: boolean;
}

export interface CatalogRouteDecision {
    view: ActiveOfferingView;
    /** true = 未用默认绑定，走了迁移链 */
    viaFallback: boolean;
    /** 决策在候选序列中的下标 */
    index: number;
    /** 依次尝试过的候选（含被剔除者与最终命中者） */
    considered: OfferingId[];
}

/** 按 DriverConfig 默认绑定 → 迁移链顺序路由；全部不可用 → null。 */
export function routeOffering(
    snapshot: CatalogSnapshot,
    request: CatalogRouteRequest,
): CatalogRouteDecision | null {
    const { driverConfig } = request;
    const order: OfferingId[] = [];
    const push = (id: OfferingId): void => {
        if (!order.includes(id)) order.push(id);
    };
    push(driverConfig.offeringId);
    for (const id of driverConfig.fallbackOfferingIds) push(id);

    const requirePricing = request.requirePricing ?? true;
    const minHealth = request.minHealth ?? 1;
    const considered: OfferingId[] = [];
    for (let index = 0; index < order.length; index += 1) {
        const offeringId = order[index] as OfferingId;
        considered.push(offeringId);
        const view = findOfferingView(snapshot, offeringId);
        if (view === null) continue;
        if (requirePricing && view.pricing === null) continue;
        if (!capabilitySatisfies(view.effectiveCapabilities, request.requiredCapabilities)) {
            continue;
        }
        if (request.healthOf !== undefined && request.healthOf(offeringId) < minHealth) continue;
        return { view, viaFallback: index > 0, index, considered };
    }
    return null;
}
