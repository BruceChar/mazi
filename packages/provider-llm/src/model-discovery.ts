import type { Model, Models } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { DEFAULT_API_KEY_ENV } from './pi-ai-driver.js';

export interface ModelDiscoveryResult {
    /** true = 已通过远端目录刷新（需配置 key 且厂商支持动态目录） */
    refreshed: boolean;
    /** 去重后的模型 id 列表（已刷新优先，失败回退本地目录） */
    models: string[];
    /** 刷新的错误信息（refresh 失败但本地目录仍可用时填充） */
    warning?: string;
}

export interface ModelDiscoveryDeps {
    models?: Models;
    now?: () => number;
}

/**
 * 动态模型发现（设计文档 §2 / U3）：
 * 1. provider 有可用 key（默认 env 或 apiKeyEnv）→ `Models.refresh` 拉取最新目录；
 * 2. 候选 = 刷新后的 `getModels(provider)`；失败/无 key → 回退本地静态目录并提示。
 */
export async function discoverModels(
    providerId: string,
    opts: { apiKeyEnv?: string } = {},
    deps: ModelDiscoveryDeps = {},
): Promise<ModelDiscoveryResult> {
    const models = deps.models ?? builtinModels();
    const staticIds = models
        .getModels(providerId)
        .map((m: Model<string>) => m.id)
        .filter(Boolean);
    // 解析可用 key（pi-ai 自身 auth 读取其默认 env 名）
    const defaultEnv = DEFAULT_API_KEY_ENV[providerId];
    const custom = opts.apiKeyEnv ? process.env[opts.apiKeyEnv] : undefined;
    const defaultVal = defaultEnv ? process.env[defaultEnv] : undefined;
    const key = custom ?? defaultVal;
    if (!key || !defaultEnv) {
        return { refreshed: false, models: uniqueIds(staticIds) };
    }
    // 自定义 env 名的 key 需回填到 pi-ai 默认 env 才能被其 auth 读到
    const previous = process.env[defaultEnv];
    if (custom && previous === undefined) {
        process.env[defaultEnv] = key;
    }
    try {
        await models.refresh({ providers: [providerId] });
        const fresh = models
            .getModels(providerId)
            .map((m: Model<string>) => m.id)
            .filter(Boolean);
        return {
            refreshed: true,
            models: fresh.length > 0 ? uniqueIds(fresh) : uniqueIds(staticIds),
        };
    } catch (error) {
        return {
            refreshed: false,
            models: uniqueIds(staticIds),
            warning: (error as Error).message,
        };
    } finally {
        if (custom && previous === undefined) {
            delete process.env[defaultEnv];
        }
    }
}

function uniqueIds(ids: string[]): string[] {
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}
