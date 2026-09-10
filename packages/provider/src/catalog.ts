/**
 * catalog —— provider 目录的运行时视图（能力 + 平台价格）。
 *
 * 通过 Provider 接口的 listModels() 读取：对已知厂商构造 adapter 后调用；
 * 未知厂商 / 目录缺失 → []（不抛错、不覆盖配置）。
 */

import { getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
import type { ProviderModelInfo } from '@mazi/core';
import { deepseekAdapter, knownDeepseekModels } from './from-config.js';

/** 兼容旧名：目录模型视图。 */
export type CatalogModel = ProviderModelInfo;

const catalogCache = new Map<string, ProviderModelInfo[]>();

/**
 * pi-ai 目录更新滞后时的本地补充：厂商已发布但目录未收录的模型。
 * 以目录模板克隆元数据（能力/价格后续可由目录覆盖）；需要增删改这里即可。
 */
const DEEPSEEK_CATALOG_SUPPLEMENT = ['deepseek-v41-flash'];

/** 读取指定厂商（pi-ai provider id，如 deepseek）的模型目录（能力 + 价格）；未知厂商 → []。 */
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
                    models: [
                        { id: known[0] as string },
                        ...DEEPSEEK_CATALOG_SUPPLEMENT.map((id) => ({ id })),
                    ],
                });
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
