/**
 * Provider Client：LLMProvider 之上的一层（观察者层）。
 *
 * 分层（依赖倒置，同构于 Provider 栈）：
 *   core      LLMProvider（契约）—— 只声明 ask / askStream / models / capabilities
 *   ↑ client  （本文件）—— 日志 / 事件 / 监测 + 重试 / 超时 / 错误映射；
 *             实现同一 LLMProvider 契约，对上层（引擎 / Agent）完全透明
 *   ↑ adapter —— 只做 SDK 协议映射（canonical Message ↔ 厂商格式），见 ./pi-ai-adapter.ts
 *   ↑ provider —— 厂商具体化（模型表 / 思考参数 / 默认值），并组合出开箱即用的 client，
 *                 见 ./deepseek.ts（@mazi/provider 单包内完成组装）
 *
 * 职责红线：
 *   - 只做横切关注点：日志、事件、监测、重试、超时、统一错误码；
 *   - 不做业务状态：消息历史、上下文窗口、工具决策、对话状态一律不碰；
 *   - 组装发生在 wiring 层（谁用谁包）：
 *       const client = createProviderClient({ provider: createDeepSeekClient(), maxRetries: 2 })
 *     引擎只认识 LLMProvider，不感知 client 的存在。
 *
 * 契约要点（packages/core/src/provider.ts，规范 docs/core/AHF_CORE_PROVIDER.md）：
 *   - ProviderError 不含 retryable —— 策略判断在本层：按错误码决定是否重试；
 *   - 重试集合：rate_limit / timeout / network / provider_unavailable。
 */

import type {
    LLMProvider,
    LLMRequest,
    LLMResponse,
    MapProviderError,
    StreamCompletionEvent,
} from '@mazi/core';
import { ProviderError } from '@mazi/core';

/** 宿主日志接口（最小约定；实现方可为 console / pino 等）。 */
export interface ProviderLogger {
    log(
        level: 'debug' | 'info' | 'warn' | 'error',
        event: string,
        fields?: Record<string, unknown>,
    ): void;
}

/* ------------------------- 错误映射（默认启发式） ------------------------- */

/** 可重试错误码（超时/限流/网络/厂商不可用；auth/上下文/请求非法等不重试）。 */
const RETRYABLE_CODES: ReadonlySet<string> = new Set([
    'rate_limit',
    'timeout',
    'network',
    'provider_unavailable',
]);

function isRetryable(code: string): boolean {
    return RETRYABLE_CODES.has(code);
}

/** 默认映射器：透传 ProviderError；其余按消息特征启发式归类。厂商可传专属映射器覆盖。 */
export const defaultErrorMapper: MapProviderError = (error: unknown, _request: LLMRequest) => {
    if (error instanceof ProviderError) {
        return error;
    }
    if (error instanceof Error) {
        const message = error.message;
        if (/rate.?limit|429/i.test(message)) {
            return new ProviderError('rate_limit', message, { raw: error });
        }
        if (/context.?length|maximum context|tokens?/i.test(message)) {
            return new ProviderError('context_length_exceeded', message, { raw: error });
        }
        if (/unauthorized|api[ _-]?key|401|403/i.test(message)) {
            return new ProviderError('auth', message, { raw: error });
        }
        if (/timeout|ETIMEDOUT|aborted/i.test(message)) {
            return new ProviderError('timeout', message, { raw: error });
        }
        if (/fetch failed|ECONNREFUSED|ENOTFOUND|ENETUNREACH|network/i.test(message)) {
            return new ProviderError('network', message, { raw: error });
        }
        return new ProviderError('unknown', message, { raw: error });
    }
    return new ProviderError('unknown', String(error), { raw: error });
};

/* ------------------------- 事件与监测 ------------------------- */

/** client 层事件：请求 / 流式增量 / 响应 / 重试 / 错误。供日志、监测与 tracing 消费。 */
export type ProviderClientEvent =
    | { type: 'request'; model?: string; request: LLMRequest }
    | { type: 'stream-delta'; chunk: StreamCompletionEvent }
    | { type: 'response'; response: LLMResponse; durationMs: number }
    | { type: 'retry'; attempt: number; error: ProviderError; delayMs: number }
    | { type: 'error'; error: ProviderError };

/** client 层监测指标：跨请求累积，宿主可定时采样或对接监控系统。 */
export interface ProviderClientStats {
    requestCount: number;
    streamCount: number;
    errorCount: number;
    retryCount: number;
    /** 累计 token 用量（response.usage.totalTokens 求和）。 */
    totalTokens: number;
    /** 累计请求耗时（ms）。 */
    totalDurationMs: number;
    lastRequestAt?: number;
}

export interface ProviderClientOptions {
    /** 被装饰的底层 Provider（协议转换层 / adapter）。 */
    provider: LLMProvider;
    logger?: ProviderLogger;
    errorMapper?: MapProviderError;
    /** 可重试错误的最大重试次数；默认 3。 */
    maxRetries?: number;
    /** 指数退避基数（ms）；默认 250。 */
    retryBaseDelayMs?: number;
    /** 单次请求超时（ms）；默认 60_000。 */
    timeoutMs?: number;
    /** 事件观察者（日志 / 监测 / tracing）。观察者异常不阻断请求。 */
    onEvent?: (event: ProviderClientEvent) => void;
    /** 重试回调（兼容旧接口；等价于订阅 type:"retry" 事件）。 */
    onRetry?(attempt: number, error: ProviderError, delayMs: number): void;
}

/** Provider Client：LLMProvider 的超集（对引擎透明）+ 监测指标。 */
export interface ProviderClient extends LLMProvider {
    /** 跨请求累积的监测指标。 */
    readonly stats: ProviderClientStats;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_TIMEOUT_MS = 60_000;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function withTimeout(
    signal: AbortSignal | undefined,
    timeoutMs: number,
): { signal: AbortSignal; timedOut: boolean; cleanup: () => void } {
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const onAbort = (): void => {
        controller.abort(signal?.reason);
    };
    if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
    }
    if (timeoutMs > 0) {
        timer = setTimeout(() => {
            timedOut = true;
            controller.abort(
                new ProviderError('timeout', `LLM request timed out after ${timeoutMs}ms`),
            );
        }, timeoutMs);
    }

    return {
        signal: controller.signal,
        timedOut,
        cleanup() {
            if (timer !== undefined) {
                clearTimeout(timer);
            }
            if (signal) {
                signal.removeEventListener('abort', onAbort);
            }
        },
    };
}

/**
 * 创建 Provider Client：重试（指数退避）+ 超时 + 错误映射 + 日志 + 事件 + 监测。
 * 返回对象实现 LLMProvider 接口，对引擎完全透明；stats 供宿主监测。
 */
export function createProviderClient(options: ProviderClientOptions): ProviderClient {
    const inner = options.provider;
    const logger = options.logger;
    const mapper = options.errorMapper ?? defaultErrorMapper;
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const baseDelay = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const onEvent = options.onEvent;
    const onRetry = options.onRetry;

    const stats: ProviderClientStats = {
        requestCount: 0,
        streamCount: 0,
        errorCount: 0,
        retryCount: 0,
        totalTokens: 0,
        totalDurationMs: 0,
    };

    /** 事件发射：观察者异常不阻断请求（与引擎 observer 纪律一致）。 */
    const emit = (event: ProviderClientEvent): void => {
        if (!onEvent) return;
        try {
            onEvent(event);
        } catch {
            // 观察者异常不阻断执行
        }
    };

    const client: ProviderClient = {
        id: inner.id,
        name: inner.name,
        models: inner.models,
        ...(inner.defaultModel !== undefined ? { defaultModel: inner.defaultModel } : {}),
        stats,

        async ask(request) {
            const timed = withTimeout(request.signal, timeoutMs);
            const startedAt = Date.now();
            stats.requestCount += 1;
            stats.lastRequestAt = startedAt;
            emit({ type: 'request', ...(request.model ? { model: request.model } : {}), request });
            let attempt = 0;
            try {
                for (;;) {
                    try {
                        const response = await inner.ask({ ...request, signal: timed.signal });
                        const durationMs = Date.now() - startedAt;
                        stats.totalDurationMs += durationMs;
                        if (response.usage?.totalTokens) {
                            stats.totalTokens += response.usage.totalTokens;
                        }
                        logger?.log('debug', 'llm.ask', {
                            model: request.model ?? inner.defaultModel,
                            finishReason: response.finishReason,
                            durationMs,
                        });
                        emit({ type: 'response', response, durationMs });
                        return response;
                    } catch (error) {
                        if (timed.timedOut) {
                            const err = new ProviderError(
                                'timeout',
                                `LLM request timed out after ${timeoutMs}ms`,
                                { raw: error },
                            );
                            stats.errorCount += 1;
                            emit({ type: 'error', error: err });
                            throw err;
                        }
                        if (timed.signal.aborted) {
                            const err = new ProviderError('aborted', 'LLM request aborted', {
                                raw: error,
                            });
                            stats.errorCount += 1;
                            emit({ type: 'error', error: err });
                            throw err;
                        }
                        const mapped = mapper(error, request);
                        if (!isRetryable(mapped.code) || attempt >= maxRetries) {
                            stats.errorCount += 1;
                            emit({ type: 'error', error: mapped });
                            throw mapped;
                        }
                        const delay = baseDelay * 2 ** attempt;
                        stats.retryCount += 1;
                        logger?.log('warn', 'llm.ask.retry', {
                            code: mapped.code,
                            attempt,
                            delayMs: delay,
                        });
                        emit({ type: 'retry', attempt, error: mapped, delayMs: delay });
                        onRetry?.(attempt, mapped, delay);
                        await sleep(delay);
                        attempt += 1;
                    }
                }
            } finally {
                timed.cleanup();
            }
        },

        async *askStream(request) {
            const timed = withTimeout(request.signal, timeoutMs);
            const startedAt = Date.now();
            stats.requestCount += 1;
            stats.streamCount += 1;
            stats.lastRequestAt = startedAt;
            emit({ type: 'request', ...(request.model ? { model: request.model } : {}), request });
            try {
                for await (const chunk of inner.askStream({ ...request, signal: timed.signal })) {
                    emit({ type: 'stream-delta', chunk });
                    yield chunk;
                }
                stats.totalDurationMs += Date.now() - startedAt;
            } catch (error) {
                const mapped = mapper(error, request);
                stats.errorCount += 1;
                logger?.log('warn', 'llm.stream.error', {
                    code: mapped.code,
                    message: mapped.message,
                });
                emit({ type: 'error', error: mapped });
                throw mapped;
            } finally {
                timed.cleanup();
            }
        },
    };

    return client;
}
