/**
 * catalog —— provider 目录的运行时视图（能力 + 平台价格）。
 *
 * 通过 Provider 接口的 listModels() 读取：对已知厂商构造 adapter 后调用；
 * 未知厂商 / 目录缺失 → []（不抛错、不覆盖配置）。
 */

import { getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
import type { ProviderModelInfo } from '@mazi/core';
import { deepseekAdapter, knownDeepseekModels } from './from-config.js';

/**
 * DeepSeek 官方价目页地址与高峰时段定义（元 / 百万 tokens）。
 * 具体单价**不在此写死**：由设置中的 `pricing.sourceUrl` 抓取官网页面解析写入
 * （见 @mazi/provider 的 deepseek-pricing 解析器与 apps/api 的 syncOfficialPricing）。
 * 来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 */
export const DEEPSEEK_PRICING_SOURCE = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';
export const DEEPSEEK_PRICING_VERSION = 'deepseek-2026-09';
/**
 * 高峰时段 tier（×2）：北京时间周一至周五 9:00-12:00、14:00-18:00。
 * 换算 UTC 小时 = 1:00-4:00 与 6:00-10:00；UTC 星期 1-5（这些窗口不跨 UTC 日界）。
 */
export const DEEPSEEK_PEAK_TIERS = [
    {
        name: 'peak',
        weekdays: [1, 2, 3, 4, 5],
        windowHoursUtc: [1, 4] as [number, number],
        multiplier: 2,
    },
    {
        name: 'peak',
        weekdays: [1, 2, 3, 4, 5],
        windowHoursUtc: [6, 10] as [number, number],
        multiplier: 2,
    },
];

/** pro (reasoner) vs flash 归类；未知按 flash。 */
export function deepseekTierOf(modelId: string): 'flash' | 'pro' {
    return /pro|reasoner/i.test(modelId) ? 'pro' : 'flash';
}

/** 兼容旧名：目录模型视图。 */
export type CatalogModel = ProviderModelInfo;

const catalogCache = new Map<string, ProviderModelInfo[]>();

/**
 * 读取指定厂商（pi-ai provider id，如 deepseek）的**离线**模型目录（能力 + 价格）；未知厂商 → []。
 * 注意：这是本地回退目录，厂商真实模型名可能不同（见 model-discovery 的在线发现）；
 * 不得在此硬编码厂商未发布的模型 id（曾因 deepseek-v41-flash 导致线上 400）。
 */
export function builtinModelsFor(vendor: string): ProviderModelInfo[] {
    const cached = catalogCache.get(vendor);
    if (cached !== undefined) {
        return cached;
    }
    let models: ProviderModelInfo[] = [];
    try {
        if (vendor === 'deepseek') {
            const known = knownDeepseekModels();
            if (known.length > 0) {
                const provider = deepseekAdapter({
                    id: vendor,
                    adapter: 'deepseek',
                    models: [{ id: known[0] as string }],
                });
                // 价格不在此覆盖：由官网抓取（syncOfficialPricing）写入 providers.json。
                models = provider.listModels();
            }
        }
    } catch {
        models = [];
    }
    catalogCache.set(vendor, models);
    return models;
}

/** 目录内置的全部厂商 id（诊断用）。 */
export function builtinVendors(): string[] {
    try {
        return getBuiltinProviders() as string[];
    } catch {
        return [];
    }
}
