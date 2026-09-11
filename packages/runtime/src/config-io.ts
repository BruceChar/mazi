import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { PermissionLevel } from '@mazi/core';
import type { ProviderOverview } from '@mazi/libs';
import { builtinModelsFor } from '@mazi/provider';
import type { ProviderConfig, RuntimeConfig, ToolConfig } from './config.js';
import { ensureMaziDirs, maziPaths } from './paths.js';

/** settings.json 结构：系统级 Goal 配置（权限 grant 等），与 providers/tools 分离。 */
export interface RuntimeSettingsFile {
    goal?: {
        permissionCeiling?: PermissionLevel;
        allowedTools?: string[];
    };
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

/** 写入 settings.json（与既有内容合并；用于系统级 Goal 配置，如权限 grant）。 */
export function saveRuntimeSettings(settings: RuntimeSettingsFile, configDir?: string): void {
    const home = configDir && configDir.length > 0 ? configDir : undefined;
    const paths = home ? maziPaths(home) : ensureMaziDirs();
    const current = (readJson(paths.settingsFile) as RuntimeSettingsFile | undefined) ?? {};
    const next: RuntimeSettingsFile = {
        ...current,
        goal: { ...current.goal, ...settings.goal },
    };
    mkdirSync(paths.home, { recursive: true });
    writeFileSync(paths.settingsFile, `${JSON.stringify(next, null, 2)}\n`);
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
            // 目录（能力 + 平台价格）按 vendor 读取并按 id 合并到配置模型上。
            const infos = builtinModelsFor(p.driver?.provider ?? '');
            const byId = new Map(infos.map((info) => [info.id, info]));
            return {
                id: p.id,
                vendor: p.vendor,
                models: (p.models ?? []).map((m) => {
                    const info = byId.get(m.id);
                    return {
                        id: m.id,
                        name: m.name,
                        ...(m.contextWindow !== undefined
                            ? { contextWindow: m.contextWindow }
                            : {}),
                        ...(m.maxTokens !== undefined ? { maxTokens: m.maxTokens } : {}),
                        ...(info?.pricing ? { pricing: info.pricing } : {}),
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
