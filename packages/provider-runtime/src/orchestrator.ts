/**
 * RoundExecutor —— 实现 AHF_RUNTIME_PROVIDER §4（编排层）。
 *
 * 一轮 LLM 调用（Round）的唯一执行路径：
 *   candidates 序列 → 逐 candidate：熔断询问 → 限流 acquire → 信号合成(timeout/caller)
 *   → provider.askStream → aggregateStream(§3) → 计价(§5) → RoundMetrics 打点
 *   → health/breaker 更新 → 失败按 RetryPolicy(§6.1) 本地重试/换家/冒泡，整轮 maxAttempts 封顶。
 *
 * 与 core 的边界（§1.2）：本层做判断与测量，core 只供事实。错误码（[CORE §8.8]）为决策
 * 唯一输入；finishReason='insufficient_system_resource' 走 provider_unavailable 决策行（§6.1）。
 */

import type {
    LLMFinishReason,
    LLMProvider,
    LLMRequest,
    LLMResponse,
    ProviderErrorCode,
    TokenUsage,
} from '@mazi/core';
import { ProviderError } from '@mazi/core';
import { aggregateStream } from './aggregate.js';
import type { HealthTracker } from './health.js';
import type { Limiter } from './limiter.js';
import { computeCostUsd, type PricingSchedule } from './pricing.js';
import {
    type CircuitBreaker,
    classifyFinishReason,
    DEFAULT_MAX_ATTEMPTS,
    DEFAULT_RETRY_POLICY,
    decisionForErrorCode,
    type RetryPolicyTable,
    retryDelayMs,
} from './retry.js';

// ------------------------------------------------------------
// 事件与类型（§4.4 RoundMetrics）
// ------------------------------------------------------------

export interface RoundMetrics {
    providerId: string;
    modelId: string;
    ok: boolean;
    finishReason?: LLMFinishReason;
    /** [CORE §8] 归一后事实（全量口径） */
    usage?: TokenUsage;
    /** §5 派生 */
    costUsd?: number;
    /** §3 打点 */
    ttftMs?: number;
    totalMs: number;
    errorCode?: ProviderErrorCode;
    /** 含重试的总尝试次数 */
    attempts: number;
    /** §4.2 判断结果 */
    abortedBy?: 'caller' | 'timeout' | null;
    /** faux 轮次标记：不进画像/账本（§9.3） */
    synthetic?: boolean;
    at: number;
}

export interface RoundCandidate {
    providerId: string;
    provider: LLMProvider;
    /** 缺省 provider.defaultModel */
    modelId?: string;
    /** 模型/端点级超时覆盖；缺省用 RoundExecutorOptions.timeoutMs */
    timeoutMs?: number;
    /** 计价表；缺省不产 costUsd */
    pricing?: PricingSchedule;
    /** faux 候选（§9.3）：metrics.synthetic=true */
    synthetic?: boolean;
}

export interface RoundAttemptLogEntry {
    providerId: string;
    modelId: string;
    ok: boolean;
    errorCode?: ProviderErrorCode;
    finishReason?: LLMFinishReason;
    /** 失败后到下一次尝试的退避（ms）；成功轮为 0 */
    delayMs: number;
    /** 未发起网络的跳过原因（熔断） */
    skipReason?: 'breaker-open';
    abortedBy?: 'caller' | 'timeout' | null;
}

export interface RoundOutcome {
    response: LLMResponse;
    metrics: RoundMetrics;
    attempts: RoundAttemptLogEntry[];
}

export interface RoundExecutorOptions {
    limiter?: Limiter;
    breaker?: CircuitBreaker;
    health?: HealthTracker;
    retryPolicy?: RetryPolicyTable;
    maxAttempts?: number;
    /** 端点/模型级缺省超时（默认 60s） */
    timeoutMs?: number;
    /** RoundMetrics 汇入点（观测/计费/画像唯一入口，§4.4） */
    onMetrics?: (metrics: RoundMetrics) => void;
    now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** 粗估请求输入 token（tpm acquire 用；字符数/4 + 图片/工具 schema 估算，§15 开放问题 #1）。 */
export function estimateInputTokens(request: LLMRequest): number {
    let chars = 0;
    const pushText = (text: string | undefined): void => {
        if (text) chars += text.length;
    };
    if (request.system) {
        if (typeof request.system === 'string') pushText(request.system);
        else for (const block of request.system) pushText(block.text);
    }
    for (const message of request.messages) {
        if ('content' in message) {
            for (const block of message.content) {
                if (block.type === 'text') chars += block.text.length;
                else if (block.type === 'reasoning') chars += block.text.length;
                else if (block.type === 'image')
                    chars += 1000; // 图片约 1K token
                else chars += 500;
            }
        }
        if (message.role === 'assistant') {
            for (const call of message.toolCalls ?? []) {
                chars += call.name.length + JSON.stringify(call.arguments ?? {}).length;
            }
        }
        if (message.role === 'tool') {
            for (const result of message.results) {
                chars += typeof result.output === 'string' ? result.output.length : 100;
            }
        }
    }
    for (const tool of request.tools ?? []) {
        chars +=
            tool.name.length +
            tool.description.length +
            JSON.stringify(tool.parameters ?? {}).length;
    }
    return Math.max(1, Math.ceil(chars / 4));
}

function zeroUsage(inputTokens: number): TokenUsage {
    return { inputTokens, outputTokens: 0, totalTokens: inputTokens };
}

/**
 * 信号合成（§4.2）：runtime 定时器触发 → 归类 timeout（进决策表、计健康）；
 * 调用方 signal 触发 → 归类 aborted（不计错误率、不降健康）。
 */
function composeSignal(
    caller: AbortSignal | undefined,
    timeoutMs: number,
    now: () => number,
): {
    signal: AbortSignal;
    timedOut: () => boolean;
    callerAborted: () => boolean;
    cleanup: () => void;
} {
    const controller = new AbortController();
    let timedOut = false;
    const startedAt = now();
    const timer = setTimeout(
        () => {
            timedOut = true;
            controller.abort();
        },
        Math.max(0, timeoutMs),
    );
    const onCallerAbort = (): void => {
        controller.abort();
    };
    if (caller) {
        if (caller.aborted) {
            clearTimeout(timer);
            controller.abort();
        } else {
            caller.addEventListener('abort', onCallerAbort, { once: true });
        }
    }
    return {
        signal: controller.signal,
        timedOut: () => timedOut,
        callerAborted: () => caller?.aborted ?? false,
        cleanup: () => {
            clearTimeout(timer);
            void startedAt;
            if (caller) caller.removeEventListener('abort', onCallerAbort);
        },
    };
}

export class RoundExecutor {
    private readonly opts: Required<
        Pick<RoundExecutorOptions, 'maxAttempts' | 'timeoutMs' | 'now'>
    > &
        Omit<RoundExecutorOptions, 'maxAttempts' | 'timeoutMs' | 'now'>;
    private readonly policy: RetryPolicyTable;

    constructor(options: RoundExecutorOptions = {}) {
        this.opts = {
            ...options,
            maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
            timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            now: options.now ?? Date.now,
        };
        this.policy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    }

    /** 执行一轮：候选序列 + 重试/failover/熔断/限流/打点。 */
    async execute(
        request: LLMRequest,
        candidates: readonly RoundCandidate[],
    ): Promise<RoundOutcome> {
        const maxAttempts = this.opts.maxAttempts;
        const attemptsLog: RoundAttemptLogEntry[] = [];
        const metricBatch: RoundMetrics[] = [];
        const emit = (metrics: RoundMetrics): void => {
            metricBatch.push(metrics);
            this.opts.onMetrics?.(metrics);
        };
        let lastError: ProviderError | undefined;
        let attemptsUsed = 0;

        for (const candidate of candidates) {
            const modelId = request.model ?? candidate.modelId ?? candidate.provider.defaultModel;
            if (modelId === undefined) {
                throw new ProviderError(
                    'invalid_request',
                    `no model resolved for provider ${candidate.providerId} (set request.model / candidate.modelId / provider.defaultModel)`,
                );
            }

            // 熔断询问（§6.2）
            if (
                this.opts.breaker &&
                !this.opts.breaker.allow(
                    candidate.providerId,
                    () => this.opts.health?.score(candidate.providerId) ?? 100,
                )
            ) {
                attemptsLog.push({
                    providerId: candidate.providerId,
                    modelId,
                    ok: false,
                    delayMs: 0,
                    skipReason: 'breaker-open',
                });
                continue;
            }

            // 本地重试循环（同一 candidate）
            for (let localAttempt = 0; ; localAttempt += 1) {
                if (attemptsUsed >= maxAttempts) break;
                const signal = composeSignal(
                    request.signal,
                    candidate.timeoutMs ?? this.opts.timeoutMs,
                    this.opts.now,
                );
                const roundStartedAt = this.opts.now();
                const estimate = estimateInputTokens(request);
                if (this.opts.limiter) {
                    await this.opts.limiter.acquire(candidate.providerId, estimate);
                }
                const roundRequest: LLMRequest = {
                    ...request,
                    model: modelId,
                    signal: signal.signal,
                };
                try {
                    const stream = candidate.provider.askStream(roundRequest);
                    const timers = { startedAt: roundStartedAt };
                    const round = await aggregateStream(stream, timers);
                    const finishReason = round.response.finishReason;

                    // finishReason 特殊通道（§6.1）：insufficient_system_resource 按 provider_unavailable 行处理
                    const channelCode = classifyFinishReason(finishReason);
                    if (channelCode !== null) {
                        const decision = decisionForErrorCode(channelCode, this.policy);
                        attemptsUsed += 1;
                        attemptsLog.push({
                            providerId: candidate.providerId,
                            modelId,
                            ok: false,
                            errorCode: channelCode,
                            finishReason,
                            delayMs: 0,
                        });
                        this.opts.health?.track(candidate.providerId, {
                            ok: false,
                            errorCode: channelCode,
                        });
                        if (decision.countsAsError)
                            this.opts.breaker?.recordFailure(candidate.providerId);
                        emit({
                            providerId: candidate.providerId,
                            modelId,
                            ok: false,
                            finishReason,
                            errorCode: channelCode,
                            attempts: attemptsUsed,
                            totalMs: this.opts.now() - roundStartedAt,
                            synthetic: candidate.synthetic,
                            at: this.opts.now(),
                        });
                        if (attemptsUsed >= maxAttempts) {
                            lastError = new ProviderError(
                                channelCode,
                                `finishReason=${finishReason}`,
                            );
                            signal.cleanup();
                            this.opts.limiter?.settle(candidate.providerId, zeroUsage(estimate));
                            break;
                        }
                        if (localAttempt >= decision.localRetries) {
                            lastError = new ProviderError(
                                channelCode,
                                `finishReason=${finishReason}`,
                            );
                            signal.cleanup();
                            this.opts.limiter?.settle(candidate.providerId, zeroUsage(estimate));
                            break;
                        }
                        const delay = retryDelayMs(channelCode, localAttempt, {
                            policy: this.policy,
                        });
                        signal.cleanup();
                        this.opts.limiter?.settle(candidate.providerId, zeroUsage(estimate));
                        await sleep(delay);
                        continue;
                    }

                    // 成功
                    attemptsUsed += 1;
                    const usage = round.response.usage;
                    const costUsd =
                        usage !== undefined && candidate.pricing
                            ? computeCostUsd(usage, candidate.pricing, new Date(this.opts.now()))
                            : undefined;
                    attemptsLog.push({
                        providerId: candidate.providerId,
                        modelId,
                        ok: true,
                        finishReason,
                        delayMs: 0,
                    });
                    this.opts.health?.track(candidate.providerId, { ok: true });
                    this.opts.breaker?.recordSuccess(candidate.providerId);
                    this.opts.limiter?.settle(candidate.providerId, usage ?? zeroUsage(estimate));
                    const metrics: RoundMetrics = {
                        providerId: candidate.providerId,
                        modelId,
                        ok: true,
                        ...(finishReason ? { finishReason } : {}),
                        ...(usage ? { usage } : {}),
                        ...(costUsd !== undefined ? { costUsd } : {}),
                        ...(round.ttftMs !== undefined ? { ttftMs: round.ttftMs } : {}),
                        totalMs: this.opts.now() - roundStartedAt,
                        attempts: attemptsUsed,
                        synthetic: candidate.synthetic,
                        at: this.opts.now(),
                    };
                    emit(metrics);
                    signal.cleanup();
                    return { response: round.response, metrics, attempts: attemptsLog };
                } catch (error) {
                    const mapped =
                        error instanceof ProviderError
                            ? error
                            : new ProviderError(
                                  'unknown',
                                  error instanceof Error ? error.message : String(error),
                              );
                    signal.cleanup();

                    // §4.2 判定：定时器 vs 调用方取消
                    let effectiveCode: ProviderErrorCode = mapped.code;
                    let abortedBy: RoundMetrics['abortedBy'] = null;
                    if (signal.timedOut() && mapped.code === 'aborted') {
                        effectiveCode = 'timeout';
                        abortedBy = 'timeout';
                    } else if (signal.callerAborted() || mapped.code === 'aborted') {
                        abortedBy = 'caller';
                        effectiveCode = 'aborted';
                    }
                    const decision = decisionForErrorCode(effectiveCode, this.policy);
                    // 最终抛出的错误用重编码后的 code（timeout 通道等），保证上层/账本一致
                    const thrownError =
                        effectiveCode === mapped.code
                            ? mapped
                            : new ProviderError(effectiveCode, mapped.message, {
                                  retryAfterMs: mapped.retryAfterMs,
                              });
                    attemptsUsed += 1;
                    attemptsLog.push({
                        providerId: candidate.providerId,
                        modelId,
                        ok: false,
                        errorCode: effectiveCode,
                        delayMs: 0,
                        abortedBy,
                    });
                    this.opts.health?.track(candidate.providerId, {
                        ok: false,
                        errorCode: effectiveCode,
                        abortedBy,
                    });
                    if (decision.countsAsError)
                        this.opts.breaker?.recordFailure(candidate.providerId);
                    emit({
                        providerId: candidate.providerId,
                        modelId,
                        ok: false,
                        errorCode: effectiveCode,
                        abortedBy,
                        attempts: attemptsUsed,
                        totalMs: this.opts.now() - roundStartedAt,
                        synthetic: candidate.synthetic,
                        at: this.opts.now(),
                    });

                    // caller 取消 / invalid_request：直接冒泡（§6.1 行）
                    if (effectiveCode === 'aborted' || effectiveCode === 'invalid_request') {
                        lastError = thrownError;
                        break;
                    }
                    // 本地重试
                    if (localAttempt < decision.localRetries && attemptsUsed < maxAttempts) {
                        const delay = retryDelayMs(effectiveCode, localAttempt, {
                            retryAfterMs: mapped.retryAfterMs,
                            policy: this.policy,
                        });
                        attemptsLog[attemptsLog.length - 1].delayMs = delay;
                        await sleep(delay);
                        continue;
                    }
                    // 换家 / 冒泡
                    lastError = thrownError;
                    if (!decision.failover) break;
                    break;
                } finally {
                    // noop：本地状态已在分支内维护
                }
            }
            if (
                lastError !== undefined &&
                !decisionForErrorCode(lastError.code, this.policy).failover
            ) {
                break;
            }
            if (lastError !== undefined && attemptsUsed >= maxAttempts) {
                break;
            }
            // 进入下一 candidate（failover）
        }

        throw (
            lastError ??
            new ProviderError(
                'provider_unavailable',
                'no candidate available for this round (circuit breaker / health gate)',
            )
        );
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
