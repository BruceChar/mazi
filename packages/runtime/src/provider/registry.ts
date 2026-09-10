/**
 * ProviderRegistry —— 实现 AHF_RUNTIME_PROVIDER §9.4（含 faux 防线 §9.3）。
 * Adapter 由外部注入（AdapterCatalog），本包不 import 任何厂商 SDK（§11 依赖倒置）。
 */

import type { LLMProvider } from '@mazi/core';
import { ConfigValidationError, type ProviderConfig, validateProviderConfig } from './config.js';

/** Adapter 工厂（同步；异步初始化由调用方在注入前完成并缓存实例）。 */
export type AdapterFactory = (config: ProviderConfig) => LLMProvider;

export interface AdapterCatalog {
    [adapterId: string]: AdapterFactory;
}

export interface ProviderRegistryOptions {
    allowFaux: boolean;
    adapters: AdapterCatalog;
    env?: Record<string, string | undefined>;
}

export class ProviderRegistry {
    private readonly providers = new Map<string, LLMProvider>();
    private readonly providerConfigs: ProviderConfig[];
    private readonly options: ProviderRegistryOptions;

    constructor(options: ProviderRegistryOptions, initialConfigs: ProviderConfig[] = []) {
        this.options = options;
        this.providerConfigs = [...initialConfigs];
        if (initialConfigs.length > 0) this.register(initialConfigs);
    }

    /** 注册并实例化（逐个启动校验；失败抛 ConfigValidationError）。 */
    register(configs: ProviderConfig[]): void {
        for (const config of configs) {
            validateProviderConfig(config, {
                allowFaux: this.options.allowFaux,
                env: this.options.env,
            });
            const factory = this.options.adapters[config.adapter];
            if (!factory) {
                throw new ConfigValidationError([
                    `providers[${config.id}]: no adapter factory registered for '${config.adapter}'`,
                ]);
            }
            if (this.providers.has(config.id)) {
                throw new ConfigValidationError([`providers[${config.id}]: duplicate provider id`]);
            }
            this.providers.set(config.id, factory(config));
        }
    }

    /** 未注册 → 抛装配错误（§9.4） */
    get(providerId: string): LLMProvider {
        const provider = this.providers.get(providerId);
        if (!provider) {
            throw new Error(`provider '${providerId}' is not registered`);
        }
        return provider;
    }

    list(): LLMProvider[] {
        return [...this.providers.values()];
    }

    configs(): readonly ProviderConfig[] {
        return this.providerConfigs;
    }
}
