/**
 * model-discovery —— 从厂商端点发现真实可用模型（在线权威）。
 *
 * 背景：pi-ai 内置目录可能滞后于厂商实际发布的模型名（例如目录含 deepseek-v4-flash，
 * 端点实际只接受 deepseek-flash），把目录名直接发给厂商会得到 invalid_request。
 * 因此模型同步优先调用 OpenAI 兼容的 GET /models，以其返回为准。
 */

import { DEEPSEEK_BASE_URL } from './deepseek.js';

export interface RemoteModelDiscoveryOptions {
    providerId: string;
    apiKey?: string;
    baseUrl?: string;
    /** 可注入 fetch（离线测试）；缺省 globalThis.fetch */
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** OpenAI/DeepSeek 兼容的 GET /models 响应 → 去重排序后的模型 id 列表。 */
export function parseModelIds(payload: unknown): string[] {
    if (typeof payload !== 'object' || payload === null) return [];
    const data = (payload as { data?: unknown }).data;
    if (!Array.isArray(data)) return [];
    const ids = new Set<string>();
    for (const item of data) {
        const id =
            item !== null && typeof item === 'object' ? (item as { id?: unknown }).id : undefined;
        if (typeof id === 'string' && id.length > 0) ids.add(id);
    }
    return [...ids].sort();
}

/**
 * 调用厂商 /models 端点。仅支持 deepseek（OpenAI 兼容）；未知 provider → 空数组。
 * 非 2xx / 网络失败 / 超时 抛错（由调用方决定回退策略）。
 */
export async function fetchRemoteModelIds(options: RemoteModelDiscoveryOptions): Promise<string[]> {
    if (options.providerId !== 'deepseek') return [];
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
        throw new Error('global fetch unavailable (pass fetchImpl)');
    }
    const baseUrl = (options.baseUrl ?? DEEPSEEK_BASE_URL).replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
        const headers: Record<string, string> = { accept: 'application/json' };
        if (options.apiKey && options.apiKey.length > 0) {
            headers.authorization = 'Bearer ' + options.apiKey;
        }
        const response = await fetchImpl(baseUrl + '/models', {
            headers,
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(
                'models endpoint returned ' + String(response.status) + ' ' + response.statusText,
            );
        }
        return parseModelIds(await response.json());
    } finally {
        clearTimeout(timer);
    }
}
