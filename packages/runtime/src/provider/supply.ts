/**
 * RoutingSupply —— 实现 AHF_RUNTIME_PROVIDER §10（路由供给接口）。
 * 只供查询，不实现评分；null = 无数据，不返回零填充伪画像（降级链由路由策略执行）。
 */

import type { ProviderCapabilities } from '@mazi/core';
import type { ProviderConfig } from './config.js';
import type { PricingSchedule } from './pricing.js';
import type { EconomicsProfile, PerformanceProfile } from './profile.js';

export interface SupplyEntry {
    providerId: string;
    modelId: string;
    capabilities: ProviderCapabilities;
    pricing: PricingSchedule;
    /** 样本不足为 null（§7.3 降级链由路由执行） */
    performance: PerformanceProfile | null;
    economics: EconomicsProfile | null;
    health: number;
    breakerOpen: boolean;
}

export interface ProfileQueryResult {
    performance?: PerformanceProfile;
    economics?: EconomicsProfile;
}

export interface RoutingSupplyOptions {
    health: (providerId: string) => number;
    breakerOpen: (providerId: string) => boolean;
    profile?: (providerId: string, modelId: string) => ProfileQueryResult | null;
}

const UNPRICED: PricingSchedule = {
    currency: 'USD',
    base: { inputPerMTok: 0, outputPerMTok: 0 },
    tiers: [],
    effectiveAt: 0,
    version: '0.0.0-unpriced',
};

export class RoutingSupply {
    private readonly configs: readonly ProviderConfig[];
    private readonly options: RoutingSupplyOptions;

    constructor(configs: readonly ProviderConfig[], options: RoutingSupplyOptions) {
        this.configs = configs;
        this.options = options;
    }

    models(): SupplyEntry[] {
        const entries: SupplyEntry[] = [];
        for (const config of this.configs) {
            for (const model of config.models) {
                const profile = this.options.profile?.(config.id, model.id) ?? null;
                entries.push({
                    providerId: config.id,
                    modelId: model.id,
                    capabilities: model.capabilities,
                    pricing: model.pricing ?? UNPRICED,
                    performance: profile?.performance ?? null,
                    economics: profile?.economics ?? null,
                    health: this.options.health(config.id),
                    breakerOpen: this.options.breakerOpen(config.id),
                });
            }
        }
        return entries;
    }
}
