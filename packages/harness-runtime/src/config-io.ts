import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FeatureFlagDefinition } from '@mazi/core';
import type { ProviderConfig, RuntimeConfig, ToolConfig } from './config.js';
import { ensureMaziDirs, maziPaths } from './paths.js';

export interface FileRuntimeConfig {
    providers: ProviderConfig[];
    tools: ToolConfig[];
    flags: FeatureFlagDefinition[];
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

/** 从 MAZI_HOME（或显式目录）加载 providers/tools/flags 配置 */
export function loadRuntimeConfig(configDir?: string): FileRuntimeConfig {
    const home = configDir && configDir.length > 0 ? configDir : undefined;
    const paths = home ? maziPaths(home) : ensureMaziDirs();
    const providersJson = readJson(paths.providersFile) as
        | { providers?: ProviderConfig[] }
        | undefined;
    const toolsJson = readJson(paths.toolsFile) as { tools?: ToolConfig[] } | undefined;
    const flagsJson = readJson(paths.flagsFile) as { flags?: FeatureFlagDefinition[] } | undefined;
    return {
        providers: providersJson?.providers ?? [],
        tools: toolsJson?.tools ?? [],
        flags: flagsJson?.flags ?? [],
    };
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

export function configOverview(): { home: string; providers: string[]; hasProvidersFile: boolean } {
    const paths = maziPaths();
    const providersJson = readJson(paths.providersFile) as
        | { providers?: ProviderConfig[] }
        | undefined;
    return {
        home: paths.home,
        providers: (providersJson?.providers ?? []).map((p) => p.id),
        hasProvidersFile: providersJson !== undefined,
    };
}
