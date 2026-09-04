import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FeatureFlagDefinition } from '@mazi/core';
import type { ProviderConfig, RuntimeConfig, ToolConfig } from '@mazi/harness-runtime';

/** 从 config 目录加载 providers.json / tools.json / flags.json */
export function loadConfig(configDir: string): RuntimeConfig {
    const read = (name: string): unknown => {
        try {
            return JSON.parse(readFileSync(join(configDir, name), 'utf8'));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return undefined;
            }
            throw error;
        }
    };
    const providersJson = read('providers.json') as { providers?: ProviderConfig[] } | undefined;
    const toolsJson = read('tools.json') as { tools?: ToolConfig[] } | undefined;
    const flagsJson = read('flags.json') as { flags?: FeatureFlagDefinition[] } | undefined;
    return {
        providers: providersJson?.providers ?? [],
        tools: toolsJson?.tools ?? [],
        flags: flagsJson?.flags ?? [],
    };
}
