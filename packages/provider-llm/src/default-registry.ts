import type { LLMDriver, Provider } from '@mazi/core';
import type { PiAiDriverConfig } from './pi-ai-driver.js';
import { PiAiDriver } from './pi-ai-driver.js';
import type { ProviderJson } from './registry.js';

/** DefaultDriverRegistry 输入签名（core Provider + ProviderJson）。 */
export interface DefaultDriverRegistryInput {
    driver?: {
        type?: 'pi-ai' | (string & {});
        model?: string;
        provider?: string;
        apiKeyEnv?: string;
    };
}

/** 按 driver.type 分派真实厂商驱动的注册表；未知类型立即失败。 */
export class DefaultDriverRegistry {
    build(_provider: Provider, json: ProviderJson): LLMDriver {
        const driver = (json.driver ?? {}) as DefaultDriverRegistryInput['driver'];
        const type = driver?.type;
        switch (type) {
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
                throw new Error(`未知或缺失 driver.type：${String(type)}（仅支持 pi-ai）`);
        }
    }
}
