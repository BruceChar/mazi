import type { FileRuntimeConfig, RuntimeConfig } from '@mazi/harness-runtime';
import { loadRuntimeConfig, toRuntimeConfig } from '@mazi/harness-runtime';

/**
 * 从 MAZI_HOME（或显式目录）加载 providers/tools/flags，
 * 并按默认 home 存储（db/events）组装 RuntimeConfig。
 */
export function loadConfig(
    configDir?: string,
    opts: { eventDir?: string; dbPath?: string } = {},
): RuntimeConfig {
    const file = loadRuntimeConfig(configDir) as FileRuntimeConfig;
    return toRuntimeConfig(file, {
        eventDir: opts.eventDir,
        dbPath: opts.dbPath,
        consoleEnabled: false,
    });
}
