/**
 * from-config —— 真实厂商 adapter 目录（provider-runtime §9.4 的注入端）。
 *
 * 把 provider-runtime 形态的 ProviderConfig（§9.1）实例化为 LLMProvider：
 *   adapter: 'deepseek' → pi-ai deepseek catalog（deepseek-v4-flash / -vision-exp / -pro）。
 * 本文件在 packages/provider（厂商侧），provider-runtime 不 import 厂商 SDK（依赖倒置 §11）；
 * 为保持解耦，这里只接受与 §9.1 对齐的结构化子集类型，不引入 provider-runtime 包。
 */

import { createModels } from '@earendil-works/pi-ai';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import type { LLMProvider } from '@mazi/core';
import { createPiProvider } from './pi-ai-adapter.js';

export const DEEPSEEK_ADAPTER_ID = 'deepseek';

export interface AdapterModelLike {
    id: string;
}

/** 与 provider-runtime §9.1 ProviderConfig 对齐的结构化子集（避免 provider→provider-runtime 依赖）。 */
export interface AdapterProviderConfigLike {
    id: string;
    adapter: string;
    apiKeyEnv?: string;
    baseUrl?: string;
    models: AdapterModelLike[];
}

export interface AdapterFactoryOptions {
    env?: Record<string, string | undefined>;
}

/** 由 ModelApi 目录解析出的 deepseek 模型（离线，pi-ai 内置目录）。 */
export function knownDeepseekModels(): string[] {
    const models = createModels();
    models.setProvider(deepseekProvider());
    return models
        .getModels('deepseek')
        .map((model) => model.id)
        .sort();
}

/**
 * 创建 deepseek adapter（同步工厂，供 ProviderRegistry 注入）。
 * 校验：config.models 的每个 id 必须存在于 pi-ai deepseek 目录；apiKey 从
 * config.apiKeyEnv ?? 'DEEPSEEK_API_KEY' 读取（不落配置文件）。
 */
export function deepseekAdapter(
    config: AdapterProviderConfigLike,
    options: AdapterFactoryOptions = {},
): LLMProvider {
    if (config.adapter !== DEEPSEEK_ADAPTER_ID) {
        throw new Error(
            `deepseekAdapter: adapter must be '${DEEPSEEK_ADAPTER_ID}', got '${config.adapter}'`,
        );
    }
    const env = options.env ?? process.env;
    const baseProvider = deepseekProvider();
    const catalogModels = baseProvider.getModels();
    const catalog = new Set(catalogModels.map((model) => model.id));
    // 目录外模型（厂商新模型 / 自定义）：克隆目录模板元数据，仅替换 id/name，
    // 使其可被 getModel 解析并按真实 id 发往厂商（能力/价格以目录模板为近似）。
    const template = catalogModels[0];
    const custom = config.models
        .filter((model) => !catalog.has(model.id))
        .map(
            (model) =>
                ({
                    ...(template as object),
                    id: model.id,
                    name: model.id,
                }) as unknown as (typeof catalogModels)[number],
        );
    const defaultModel = config.models[0]?.id;
    if (defaultModel === undefined) {
        throw new Error('deepseekAdapter: at least one model required');
    }
    const apiKey = config.apiKeyEnv ? env[config.apiKeyEnv] : env.DEEPSEEK_API_KEY;

    const models = createModels();
    models.setProvider(
        custom.length > 0
            ? { ...baseProvider, getModels: () => [...catalogModels, ...custom] }
            : baseProvider,
    );
    return createPiProvider({
        models,
        providerId: 'deepseek',
        defaultModel,
        ...(apiKey && apiKey.length > 0 ? { apiKey } : {}),
    });
}

/** 内置 adapter 目录（provider-runtime AdapterCatalog 可直接注入；faux 仅供测试装配 allowFaux:true）。 */
export const providerCatalog: Readonly<
    Record<string, (config: AdapterProviderConfigLike) => LLMProvider>
> = {
    [DEEPSEEK_ADAPTER_ID]: deepseekAdapter,
};

/** 已支持 adapter id 列表（装配/向导校验用） */
export const SUPPORTED_ADAPTERS: readonly string[] = [DEEPSEEK_ADAPTER_ID];

export interface ModelDiscoveryResult {
    /** 目录模型 id（本地 pi-ai 目录；未联网拉取） */
    models: string[];
    refreshed: boolean;
    warning?: string;
}

/** 模型发现（pi-ai 本地目录；deepseek 为内置目录，其余 provider 回退预设模型并提示） */
export async function discoverModels(
    providerId: string,
    _options?: { apiKeyEnv?: string },
): Promise<ModelDiscoveryResult> {
    if (providerId === DEEPSEEK_ADAPTER_ID) {
        return { models: knownDeepseekModels(), refreshed: true };
    }
    return {
        models: [],
        refreshed: false,
        warning: `provider '${providerId}' 暂无本地目录，使用向导预设模型`,
    };
}
