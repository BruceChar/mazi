import { readFileSync } from 'node:fs';
import type { ProviderConfig, RuntimeConfig, ToolConfig } from './config.js';
import { ensureMaziDirs, maziPaths } from './paths.js';

export interface FileRuntimeConfig {
    providers: ProviderConfig[];
    tools: ToolConfig[];
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
    return {
        providers: providersJson?.providers ?? [],
        tools: toolsJson?.tools ?? [],
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

export interface ProviderOverview {
    id: string;
    vendor?: string;
    models: Array<{ id: string; name?: string }>;
}

export function configOverview(): { home: string; providers: ProviderOverview[]; hasProvidersFile: boolean } {
    const paths = maziPaths();
    const providersJson = readJson(paths.providersFile) as
        | { providers?: ProviderConfig[] }
        | undefined;
    return {
        home: paths.home,
        providers: (providersJson?.providers ?? []).map((p) => ({
            id: p.id,
            vendor: p.vendor,
            models: (p.models ?? []).map((m) => ({ id: m.id, name: m.name })),
        })),
        hasProvidersFile: providersJson !== undefined,
    };
}
