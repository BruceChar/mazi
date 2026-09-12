import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { PermissionLevel } from '@mazi/core';
import type { ProviderOverview, ProviderPricingView } from '@mazi/libs';
import { builtinModelsFor } from '@mazi/provider';
import type { ProviderConfig, RuntimeConfig, ToolConfig } from './config.js';
import { ensureMaziDirs, maziPaths } from './paths.js';

/**
 * settings.json 结构：系统级 Goal 配置，与 providers/tools 分离。
 *
 * - `goal.permissionCeiling` 是新工作区/会话的默认权限；
 * - `permissions` 是按作用域的覆盖：`workspace:<path>` 与 `conversation:<id>`，
 *   二者相互独立，解析顺序 会话 → 工作区 → 默认。
 */
export interface RuntimeSettingsFile {
    goal?: {
        permissionCeiling?: PermissionLevel;
        allowedTools?: string[];
    };
    permissions?: Record<string, string>;
    /** 官方价目页地址（设置里可配置；空 = 不抓取）。 */
    pricing?: { sourceUrl?: string };
}

export interface FileRuntimeConfig {
    providers: ProviderConfig[];
    tools: ToolConfig[];
    goal?: RuntimeSettingsFile['goal'];
}

function readJson(file: string): unknown {
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
        }
        throw error;
    }
}

/** 从 MAZI_HOME（或显式目录）加载 providers/tools 配置（flags.json 属旧执行模型，已停止读取） */
export function loadRuntimeConfig(configDir?: string): FileRuntimeConfig {
    const home = configDir && configDir.length > 0 ? configDir : undefined;
    const paths = home ? maziPaths(home) : ensureMaziDirs();
    const providersJson = readJson(paths.providersFile) as
        | { providers?: ProviderConfig[] }
        | undefined;
    const toolsJson = readJson(paths.toolsFile) as { tools?: ToolConfig[] } | undefined;
    const settingsJson = readJson(paths.settingsFile) as RuntimeSettingsFile | undefined;
    return {
        providers: providersJson?.providers ?? [],
        tools: toolsJson?.tools ?? [],
        ...(settingsJson?.goal ? { goal: settingsJson.goal } : {}),
    };
}

/** 读取 settings.json（不存在返回空对象）。 */
export function loadRuntimeSettings(configDir?: string): RuntimeSettingsFile {
    const home = configDir && configDir.length > 0 ? configDir : undefined;
    const paths = home ? maziPaths(home) : ensureMaziDirs();
    return (readJson(paths.settingsFile) as RuntimeSettingsFile | undefined) ?? {};
}

/** 写入 settings.json（与既有内容合并；goal 与 permissions 各自浅合并）。 */
export function saveRuntimeSettings(settings: RuntimeSettingsFile, configDir?: string): void {
    const home = configDir && configDir.length > 0 ? configDir : undefined;
    const paths = home ? maziPaths(home) : ensureMaziDirs();
    const current = (readJson(paths.settingsFile) as RuntimeSettingsFile | undefined) ?? {};
    const next: RuntimeSettingsFile = {
        ...current,
        ...(settings.goal ? { goal: { ...current.goal, ...settings.goal } } : {}),
        ...(settings.permissions
            ? { permissions: { ...current.permissions, ...settings.permissions } }
            : {}),
        ...(settings.pricing ? { pricing: { ...current.pricing, ...settings.pricing } } : {}),
    };
    mkdirSync(paths.home, { recursive: true });
    writeFileSync(paths.settingsFile, `${JSON.stringify(next, null, 2)}\n`);
}

/**
 * 解析生效权限：`conversation:<id>` 覆盖 → `workspace:<path>` 覆盖 → 默认。
 * 二者独立，互不影响（不同会话/不同项目各自持有）。
 */
export function resolveScopedPermission(
    permissions: Record<string, string> | undefined,
    opts: { workspace?: string; conversationId?: string; fallback: PermissionLevel },
): PermissionLevel {
    const map = permissions ?? {};
    const conversationKey = opts.conversationId ? `conversation:${opts.conversationId}` : undefined;
    if (conversationKey && map[conversationKey]) return map[conversationKey] as PermissionLevel;
    const workspaceKey = `workspace:${opts.workspace && opts.workspace.length > 0 ? opts.workspace : '__free__'}`;
    if (map[workspaceKey]) return map[workspaceKey] as PermissionLevel;
    return opts.fallback;
}

/** 由已加载文件配置 + 存储路径默认值组装 RuntimeConfig（未显式传入则用 home 存储） */
export function toRuntimeConfig(
    file: FileRuntimeConfig,
    opts: { eventDir?: string; dbPath?: string; consoleEnabled?: boolean } = {},
): RuntimeConfig {
    const paths = maziPaths();
    return {
        ...file,
        eventDir: opts.eventDir ?? paths.eventDir,
        dbPath: opts.dbPath ?? paths.dbPath,
        consoleEnabled: opts.consoleEnabled ?? false,
    };
}

/** PricingSchedule（入库）→ 线协议价目视图。 */
function schedulePricingView(schedule: {
    currency?: string;
    base?: Record<string, number | undefined>;
    tiers?: Array<{
        name: string;
        windowHoursUtc: [number, number];
        multiplier: number;
        weekdays?: number[];
    }>;
    version?: string;
    effectiveAt?: number;
}): ProviderPricingView {
    return {
        currency: schedule.currency === 'CNY' ? 'CNY' : 'USD',
        base: {
            ...(schedule.base?.inputPerMTok !== undefined
                ? { inputPerMTok: schedule.base.inputPerMTok }
                : {}),
            ...(schedule.base?.outputPerMTok !== undefined
                ? { outputPerMTok: schedule.base.outputPerMTok }
                : {}),
            ...(schedule.base?.cacheReadPerMTok !== undefined
                ? { cacheReadPerMTok: schedule.base.cacheReadPerMTok }
                : {}),
            ...(schedule.base?.cacheWritePerMTok !== undefined
                ? { cacheWritePerMTok: schedule.base.cacheWritePerMTok }
                : {}),
            ...(schedule.base?.reasoningPerMTok !== undefined
                ? { reasoningPerMTok: schedule.base.reasoningPerMTok }
                : {}),
        },
        ...(Array.isArray(schedule.tiers) && schedule.tiers.length > 0
            ? {
                  tiers: schedule.tiers.map((tier) => ({
                      name: tier.name,
                      windowHoursUtc: tier.windowHoursUtc,
                      multiplier: tier.multiplier,
                      ...(tier.weekdays !== undefined ? { weekdays: tier.weekdays } : {}),
                  })),
              }
            : {}),
        ...(schedule.version !== undefined ? { version: schedule.version } : {}),
        ...(schedule.effectiveAt !== undefined ? { effectiveAt: schedule.effectiveAt } : {}),
    };
}

/** pi-ai 目录价（扁平 USD）→ 价目视图。 */
function flatPricingView(pricing: {
    inputPerMTok?: number;
    outputPerMTok?: number;
    cacheReadPerMTok?: number;
    cacheWritePerMTok?: number;
    currency?: 'USD' | 'CNY';
}): ProviderPricingView {
    return {
        currency: pricing.currency === 'CNY' ? 'CNY' : 'USD',
        base: {
            ...(pricing.inputPerMTok !== undefined ? { inputPerMTok: pricing.inputPerMTok } : {}),
            ...(pricing.outputPerMTok !== undefined
                ? { outputPerMTok: pricing.outputPerMTok }
                : {}),
            ...(pricing.cacheReadPerMTok !== undefined
                ? { cacheReadPerMTok: pricing.cacheReadPerMTok }
                : {}),
            ...(pricing.cacheWritePerMTok !== undefined
                ? { cacheWritePerMTok: pricing.cacheWritePerMTok }
                : {}),
        },
    };
}

export function configOverview(): {
    home: string;
    providers: ProviderOverview[];
    hasProvidersFile: boolean;
} {
    const paths = maziPaths();
    const providersJson = readJson(paths.providersFile) as
        | { providers?: ProviderConfig[] }
        | undefined;
    return {
        home: paths.home,
        providers: (providersJson?.providers ?? []).map((p) => {
            // 目录（能力）按 vendor 读取并按 id 合并到配置模型上；价格优先用入库官方价。
            const infos = builtinModelsFor(p.driver?.provider ?? '');
            const byId = new Map(infos.map((info) => [info.id, info]));
            return {
                id: p.id,
                vendor: p.vendor,
                ...(p.pricing ? { pricing: schedulePricingView(p.pricing) } : {}),
                models: (p.models ?? []).map((m) => {
                    const info = byId.get(m.id);
                    const pricing =
                        m.pricing !== undefined
                            ? schedulePricingView(m.pricing)
                            : info?.pricing !== undefined
                              ? flatPricingView(info.pricing)
                              : undefined;
                    return {
                        id: m.id,
                        name: m.name,
                        ...(m.contextWindow !== undefined
                            ? { contextWindow: m.contextWindow }
                            : {}),
                        ...(m.maxTokens !== undefined ? { maxTokens: m.maxTokens } : {}),
                        ...(pricing !== undefined ? { pricing } : {}),
                        ...(info !== undefined
                            ? {
                                  capabilities: {
                                      supportsTools: info.capabilities.supportsToolCalls,
                                      supportsReasoning:
                                          info.capabilities.supportsReasoning === true,
                                      supportsVision:
                                          info.capabilities.inputTypes.includes('image'),
                                  },
                              }
                            : {}),
                    };
                }),
            };
        }),
        hasProvidersFile: providersJson !== undefined,
    };
}
