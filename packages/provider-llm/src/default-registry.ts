import type { LLMDriver, Provider } from '@mazi/core';
import type { PiAiDriverConfig } from './pi-ai-driver.js';
import { PiAiDriver } from './pi-ai-driver.js';
import type { ProviderJson } from './registry.js';
import { ScriptedDriverRegistry } from './registry.js';

/** 与 registry.ts 的 ScriptedDriverRegistry 保持同签名（core Provider + ProviderJson） */
export interface DefaultDriverRegistryInput {
    driver?: {
        type?: 'scripted' | 'pi-ai' | (string & {});
        model?: string;
        provider?: string;
        apiKeyEnv?: string;
    };
}

/**
 * 按 driver.type 分派的统一驱动注册表（设计文档 docs/ProviderAdapter设计.md PA-3）：
 * - scripted：确定性模拟（MVP 默认演示，无凭据）
 * - pi-ai：真实厂商（@earendil-works/pi-ai），凭据经 apiKeyEnv/环境解析
 * 未知 type → 抛错（fail-fast）。
 */
export class DefaultDriverRegistry {
    private readonly scripted = new ScriptedDriverRegistry();

    build(provider: Provider, json: ProviderJson): LLMDriver {
        const driver = (json.driver ?? {}) as DefaultDriverRegistryInput['driver'];
        const type = driver?.type ?? 'scripted';
        switch (type) {
            case 'scripted':
                return this.scripted.build(provider, json);
            case 'pi-ai': {
                if (!driver?.model) {
                    throw new Error(
                        'pi-ai driver 缺少 model 字段：driver: { type: "pi-ai", provider?, model, apiKeyEnv? }',
                    );
                }
                const config: PiAiDriverConfig = {
                    type: 'pi-ai',
                    provider: driver.provider,
                    model: driver.model,
                    apiKeyEnv: driver.apiKeyEnv,
                };
                return new PiAiDriver(config);
            }
            default:
                throw new Error(`未知 driver.type：${String(type)}（支持 scripted | pi-ai）`);
        }
    }
}
