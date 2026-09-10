/**
 * Limiter —— 实现 AHF_RUNTIME_PROVIDER §4.3（端点级共享限额）。
 *
 * 同一 provider（同一 key / 端点）下全部兄弟模型共享一份限额：
 *   rpm  每分钟请求数（令牌桶：容量 = rpm，匀速回填）
 *   tpm  每分钟 token 数（记账式估计：acquire 按预估 inputTokens 扣减，
 *        settle 按实际 inputTokens 修正差额）
 *   concurrency  并发在途请求数（信号量）
 *
 * 时间与休眠可注入（now/sleep），便于离线测试。
 */

import type { TokenUsage } from '@mazi/core';

export interface ProviderLimits {
    rpm?: number;
    tpm?: number;
    concurrency?: number;
}

export interface Limiter {
    /** 阻塞直至获得额度 */
    acquire(providerId: string, estimatedInputTokens: number): Promise<void>;
    /** 轮次结束后按实际 usage 修正 tpm 账目 */
    settle(providerId: string, actualUsage: TokenUsage): void;
}

export interface EndpointLimiterOptions {
    limits: (providerId: string) => ProviderLimits | undefined;
    /** 令牌不足/并发占满时按回填速率等待 */
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    /** 精度误差容忍；默认 1e-6 */
    epsilon?: number;
}

interface Bucket {
    tokens: number;
    lastRefill: number;
}

interface EndpointState {
    rpm?: Bucket;
    tpm?: Bucket;
    inFlight: number;
    /** 本轮 acquire 的 tpm 预估（settle 时按实际修正） */
    lastEstimate: number;
}

const MIN_INTERVAL_MS = 5;

/** 令牌桶按速率回填（容量封顶）。返回回填后的桶。 */
export function refillBucket(
    bucket: Bucket,
    capacity: number,
    perMinute: number,
    now: number,
): Bucket {
    const elapsedMs = Math.max(0, now - bucket.lastRefill);
    if (elapsedMs <= 0) return bucket;
    const added = (elapsedMs / 60_000) * perMinute;
    return { tokens: Math.min(capacity, bucket.tokens + added), lastRefill: now };
}

/**
 * 距下一次可获得 amount 个 token 的等待时长（ms）。
 * perMinute ≤ 0 视为无该维度限额。
 */
export function msUntilTokens(
    bucket: Bucket,
    perMinute: number,
    amount: number,
    now: number,
): number {
    if (perMinute <= 0) return 0;
    const missing = Math.max(0, amount - bucket.tokens);
    if (missing <= 0) return 0;
    return Math.max(MIN_INTERVAL_MS, (missing / perMinute) * 60_000);
}

export class EndpointLimiter implements Limiter {
    private readonly states = new Map<string, EndpointState>();
    private readonly opts: Required<Pick<EndpointLimiterOptions, 'now' | 'sleep' | 'epsilon'>> &
        Pick<EndpointLimiterOptions, 'limits'>;

    constructor(options: EndpointLimiterOptions) {
        this.opts = {
            limits: options.limits,
            now: options.now ?? Date.now,
            sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
            epsilon: options.epsilon ?? 1e-6,
        };
    }

    private state(providerId: string): EndpointState {
        let state = this.states.get(providerId);
        if (state === undefined) {
            state = { inFlight: 0, lastEstimate: 0 };
            this.states.set(providerId, state);
        }
        return state;
    }

    private limitsOf(providerId: string): ProviderLimits {
        return this.opts.limits(providerId) ?? {};
    }

    async acquire(providerId: string, estimatedInputTokens: number): Promise<void> {
        const limits = this.limitsOf(providerId);
        for (;;) {
            const now = this.opts.now();
            const state = this.state(providerId);
            const rpm = limits.rpm ?? 0;
            const tpm = limits.tpm ?? 0;
            const concurrency = limits.concurrency ?? 0;

            // rpm 桶
            if (rpm > 0) {
                if (state.rpm === undefined) {
                    state.rpm = { tokens: rpm, lastRefill: now };
                }
                state.rpm = refillBucket(state.rpm, rpm, rpm, now);
            }
            // tpm 桶：按预估记账
            if (tpm > 0) {
                if (state.tpm === undefined) {
                    state.tpm = { tokens: tpm, lastRefill: now };
                }
                state.tpm = refillBucket(state.tpm, tpm, tpm, now);
            }

            // 并发与 rpm 的等待判定
            let waitMs = 0;
            if (concurrency > 0 && state.inFlight >= concurrency) {
                waitMs = Math.max(waitMs, MIN_INTERVAL_MS);
            }
            if (rpm > 0 && state.rpm && state.rpm.tokens < 1 - this.opts.epsilon) {
                waitMs = Math.max(waitMs, msUntilTokens(state.rpm, rpm, 1, now));
            }
            if (tpm > 0 && state.tpm) {
                if (state.tpm.tokens < estimatedInputTokens - this.opts.epsilon) {
                    waitMs = Math.max(
                        waitMs,
                        msUntilTokens(state.tpm, tpm, estimatedInputTokens, now),
                    );
                }
            }

            if (waitMs > 0) {
                await this.opts.sleep(waitMs);
                continue;
            }

            // 放行：扣减
            if (state.rpm && rpm > 0) {
                state.rpm = { ...state.rpm, tokens: state.rpm.tokens - 1 };
            }
            if (state.tpm && tpm > 0) {
                state.tpm = { ...state.tpm, tokens: state.tpm.tokens - estimatedInputTokens };
            }
            state.lastEstimate = estimatedInputTokens;
            state.inFlight += 1;
            return;
        }
    }

    settle(providerId: string, actualUsage: TokenUsage): void {
        const state = this.state(providerId);
        if (state.inFlight > 0) state.inFlight -= 1;
        const limits = this.limitsOf(providerId);
        const tpm = limits.tpm ?? 0;
        if (tpm <= 0 || state.tpm === undefined) return;
        // 单轮修正：diff = 预估 − 实际；正 → 回补（不超容量），负 → 补扣（不低于 0）
        const diff = state.lastEstimate - (actualUsage.inputTokens ?? 0);
        state.lastEstimate = 0;
        if (Math.abs(diff) <= this.opts.epsilon) return;
        const tokens = Math.min(tpm, Math.max(0, state.tpm.tokens + diff));
        state.tpm = { ...state.tpm, tokens };
    }

    /** 诊断快照（测试/观测用） */
    snapshot(providerId: string): {
        rpmTokens?: number;
        tpmTokens?: number;
        inFlight: number;
        lastEstimate: number;
    } {
        const state = this.state(providerId);
        return {
            rpmTokens: state.rpm?.tokens,
            tpmTokens: state.tpm?.tokens,
            inFlight: state.inFlight,
            lastEstimate: state.lastEstimate,
        };
    }
}
