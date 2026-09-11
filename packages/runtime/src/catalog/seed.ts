/**
 * catalog/seed —— 源配置 → v1 映射（设计文档 §12）。
 *
 * 把 legacy providers.json（ProviderConfig，定价挂在 provider 层）映射为 ObservedCatalog 走 sync 管线入库：
 *   - provider.id → Provider；vendor 取 config.vendor ?? driver.provider ?? provider.id；
 *   - provider.driver.type → Provider.driverType；provider.tags → Provider.tags；
 *   - models[] → Model（能力随型号）；每个 (provider, model) → Offering（override=null）；
 *   - provider 级 pricing 仅挂 driver.model 对应 offering（其余 offering 无价，待渠道真实模型级价格回填）；
 *   - driver.model → DriverConfig.offeringId，fallback 初始为空。
 * 定价的时段倍率档（windowHoursUtc）不是目录事实，seed 只取 base 与 effectiveAt/version。
 */

import type { DriverConfig, ModelCapabilities, PricingRates, PricingTier } from '@mazi/core';
import { modelIdOf, offeringIdOf, providerIdOf } from '@mazi/core';
import type { ProviderConfig } from '../config.js';
import type { ObservedCatalog, ObservedModel, ObservedProvider } from './sync.js';

export interface SeedResult {
    catalog: ObservedCatalog;
    driverConfigs: DriverConfig[];
}

function capabilitiesOf(model: {
    contextWindow?: number;
    maxTokens?: number;
    supportsTools?: boolean;
    supportsThinking?: boolean;
    supportsVision?: boolean;
}): ModelCapabilities {
    return {
        contextWindow: model.contextWindow ?? 0,
        maxTokens: model.maxTokens ?? 0,
        supportsThinking: model.supportsThinking ?? false,
        supportsTools: model.supportsTools ?? false,
        supportsVision: model.supportsVision ?? false,
    };
}

function ratesOf(schedule: {
    base: {
        inputPerMTok: number;
        outputPerMTok: number;
        cacheWritePerMTok?: number;
        cacheReadPerMTok?: number;
    };
}): PricingRates {
    const base = schedule.base;
    return {
        inputPerMTok: base.inputPerMTok,
        outputPerMTok: base.outputPerMTok,
        ...(base.cacheReadPerMTok !== undefined ? { cacheReadPerMTok: base.cacheReadPerMTok } : {}),
        ...(base.cacheWritePerMTok !== undefined
            ? { cacheWritePerMTok: base.cacheWritePerMTok }
            : {}),
    };
}

/** 源配置 → 观测目录 + DriverConfig；纯函数、无 IO。 */
export function observedCatalogFromProviderConfigs(configs: readonly ProviderConfig[]): SeedResult {
    const providers: ObservedProvider[] = [];
    const driverConfigs: DriverConfig[] = [];

    for (const config of configs) {
        const providerId = providerIdOf(config.id);
        const vendorId = config.vendor ?? config.driver.provider ?? config.id;
        const models =
            config.models && config.models.length > 0
                ? config.models
                : [{ id: config.driver.model }];
        const defaultModelId = config.driver.model || models[0]?.id || '';

        const observedModels: ObservedModel[] = models.map((model) => {
            const pricing =
                model.id === defaultModelId && config.pricing
                    ? {
                          currency: config.pricing.currency,
                          base: ratesOf(config.pricing),
                          tiers: [] as PricingTier[],
                          effectiveAt: config.pricing.effectiveAt,
                          version: config.pricing.version,
                      }
                    : null;
            return {
                id: model.id,
                ...(model.name !== undefined ? { name: model.name } : {}),
                vendor: { id: vendorId, displayName: vendorId },
                capabilities: capabilitiesOf(model),
                capabilitiesOverride: null,
                pricing,
            };
        });

        providers.push({
            id: config.id,
            displayName: config.id,
            driverType: config.driver.type,
            ...(config.tags !== undefined ? { tags: config.tags } : {}),
            models: observedModels,
        });

        if (defaultModelId) {
            driverConfigs.push({
                id: 'default',
                offeringId: offeringIdOf(providerId, modelIdOf(defaultModelId)),
                fallbackOfferingIds: [],
            });
        }
    }

    return { catalog: { providers }, driverConfigs };
}
