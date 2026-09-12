/**
 * secrets.json —— 供应商 API Key 的本地密钥存储。
 *
 * 与 providers.json 的 provider id 对齐：`{ providers: { [id]: { apiKey } } }`。
 * 身份：明文密钥不进入 providers.json / configOverview，仅由 API 注入 RuntimeConfig.driver.apiKey；
 * 写盘尝试 0600（失败不阻断，仅权限收紧失败）。
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { RuntimeConfig } from './config.js';
import { ensureMaziDirs, maziPaths } from './paths.js';

export interface SecretsFile {
    providers?: Record<string, { apiKey?: string }>;
}

function readSecretsFile(file: string): SecretsFile {
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
        return parsed !== null && typeof parsed === 'object' ? (parsed as SecretsFile) : {};
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
        return {};
    }
}

function pathsFor(configDir?: string): ReturnType<typeof maziPaths> {
    const home = configDir && configDir.length > 0 ? configDir : undefined;
    return home ? maziPaths(home) : ensureMaziDirs();
}

/** 读取 secrets.json（不存在/损坏返回空对象）。 */
export function loadSecrets(configDir?: string): SecretsFile {
    return readSecretsFile(pathsFor(configDir).secretsFile);
}

/** 写入/清除某 provider 的 API Key（空字符串 = 删除）；返回最新密钥表。 */
export function saveProviderApiKey(
    providerId: string,
    apiKey: string,
    configDir?: string,
): SecretsFile {
    const paths = pathsFor(configDir);
    const current = loadSecrets(configDir);
    const providers: Record<string, { apiKey?: string }> = { ...current.providers };
    const next = apiKey.trim();
    if (next.length === 0) {
        delete providers[providerId];
    } else {
        providers[providerId] = { ...providers[providerId], apiKey: next };
    }
    const file: SecretsFile = { providers };
    mkdirSync(paths.home, { recursive: true });
    writeFileSync(paths.secretsFile, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    try {
        chmodSync(paths.secretsFile, 0o600);
    } catch {
        // 权限收紧失败不阻断（如非 POSIX 文件系统）。
    }
    return file;
}

/** 把密钥注入 RuntimeConfig.providers[].driver.apiKey（显式 driver.apiKey 优先保留）。 */
export function withProviderSecrets(config: RuntimeConfig, secrets: SecretsFile): RuntimeConfig {
    const map = secrets.providers ?? {};
    return {
        ...config,
        providers: config.providers.map((provider) => {
            if (provider.driver.apiKey !== undefined && provider.driver.apiKey.length > 0) {
                return provider;
            }
            const apiKey = map[provider.id]?.apiKey?.trim();
            if (apiKey === undefined || apiKey.length === 0) return provider;
            return { ...provider, driver: { ...provider.driver, apiKey } };
        }),
    };
}

/**
 * Key 的隐私展示形态：保留首 4 + 尾 4，中间以 · 遮蔽；过短则整体遮蔽。
 * 只用于 UI 展示「已配置哪个 Key」，绝不回显完整明文。
 */
export function maskApiKey(apiKey: string): string {
    const key = apiKey.trim();
    if (key.length === 0) return '';
    if (key.length <= 8) return '········';
    return `${key.slice(0, 4)}········${key.slice(-4)}`;
}

/**
 * provider id → 已配置 Key 的**遮蔽**形态（未配置则不含该键）。
 * 供 UI 显示「已配置：sk-1········ab12」，不回显明文。
 */
export function apiKeyStatus(secrets: SecretsFile): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [id, entry] of Object.entries(secrets.providers ?? {})) {
        const masked = maskApiKey(entry.apiKey ?? '');
        if (masked.length > 0) out[id] = masked;
    }
    return out;
}
