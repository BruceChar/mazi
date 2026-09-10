/**
 * token-estimator —— 用真实 tokenizer 估算文本 token 数。
 *
 * 设计见 docs/web/观测看板设计.md §2.5：js-tiktoken 是厂商私有 tokenizer 的**近似**，
 * 仅用于暴露「runtime 估算 vs vendor 实际」的漂移，不作为计费依据。编码器进程内缓存，
 * 编码名由 RuntimeConfig.tokenizerEncoding 指定。
 */
import { getEncoding } from 'js-tiktoken';

const DEFAULT_ENCODING = 'o200k_base';
const KNOWN_ENCODINGS = new Set(['o200k_base', 'cl100k_base']);

type Encoder = ReturnType<typeof getEncoding>;

const encoders = new Map<string, Encoder>();
let activeEncoding = DEFAULT_ENCODING;
let activeEncoder: Encoder | undefined;

/** 归一化编码名：未知值回落默认并告警一次。 */
function normalizeEncoding(encoding: string | undefined): string {
    if (!encoding) {
        return DEFAULT_ENCODING;
    }
    if (KNOWN_ENCODINGS.has(encoding)) {
        return encoding;
    }
    // biome-ignore lint/suspicious/noConsole: 配置告警（面向用户运行日志）
    console.warn(
        `[runtime] unknown tokenizerEncoding '${encoding}', fallback to ${DEFAULT_ENCODING}`,
    );
    return DEFAULT_ENCODING;
}

/** 取（并缓存）指定编码的 tokenizer。 */
function tokenizerFor(encoding?: string): Encoder {
    const key = normalizeEncoding(encoding);
    const cached = encoders.get(key);
    if (cached !== undefined) {
        return cached;
    }
    const encoder = getEncoding(key as Parameters<typeof getEncoding>[0]);
    encoders.set(key, encoder);
    return encoder;
}

/** 设置估算使用的默认编码（RuntimeConfig.tokenizerEncoding）。 */
export function configureTokenizer(encoding?: string): void {
    activeEncoding = normalizeEncoding(encoding);
    activeEncoder = undefined;
}

/** 估算文本 token 数（空串 → 0）；使用配置的默认编码。 */
export function estimateTokens(text: string): number {
    if (!text) {
        return 0;
    }
    if (activeEncoder === undefined) {
        activeEncoder = tokenizerFor(activeEncoding);
    }
    return activeEncoder.encode(text).length;
}

/** 以显式编码估算（测试/多编码对比用）。 */
export function estimateTokensWith(text: string, encoding?: string): number {
    if (!text) {
        return 0;
    }
    return tokenizerFor(encoding).encode(text).length;
}
