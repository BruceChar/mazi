/**
 * Retry 策略与熔断 —— 实现 AHF_RUNTIME_PROVIDER §6。
 *
 * 决策全部外置在 RetryPolicyTable（可整体替换），错误码（[CORE §8.8]）是唯一输入。
 * 特殊通道：finishReason='insufficient_system_resource'（DeepSeek）不是 error，但策略上按
 * provider_unavailable 行处理（可重试换家）。
 * CircuitBreaker（§6.2）：端点级 —— open 期间 Limiter.acquire 直接拒绝；半开只放单个探测。
 */

import type { LLMFinishReason, ProviderErrorCode } from '@mazi/core';

export interface RetryDecision {
    /** 本地（同 candidate）重试次数上限 */
    localRetries: number;
    /** 退避：'none' 立即；'exponential' 按基数 2^attempt 指数（有上限） */
    backoff: 'none' | 'exponential';
    /** 本地重试耗尽后是否切换下一 candidate */
    failover: boolean;
    /** 健康分影响（§8）；auth 行由 HealthTracker 硬置 0，此处记 0 */
    healthImpact: number;
    /** 是否计入错误率统计 */
    countsAsError: boolean;
}

export type RetryPolicyTable = Readonly<Record<ProviderErrorCode, RetryDecision>>;

export const DEFAULT_MAX_ATTEMPTS = 4;

/** 默认决策表（§6.1） */
export const DEFAULT_RETRY_POLICY: RetryPolicyTable = {
    rate_limit: {
        localRetries: 2,
        backoff: 'exponential',
        failover: true,
        healthImpact: -2,
        countsAsError: true,
    },
    context_length_exceeded: {
        localRetries: 0,
        backoff: 'none',
        failover: true,
        healthImpact: 0,
        countsAsError: false,
    },
    auth: {
        localRetries: 0,
        backoff: 'none',
        failover: true,
        healthImpact: 0,
        countsAsError: true,
    },
    timeout: {
        localRetries: 1,
        backoff: 'exponential',
        failover: true,
        healthImpact: -8,
        countsAsError: true,
    },
    network: {
        localRetries: 2,
        backoff: 'exponential',
        failover: true,
        healthImpact: -10,
        countsAsError: true,
    },
    invalid_request: {
        localRetries: 0,
        backoff: 'none',
        failover: false,
        healthImpact: 0,
        countsAsError: false,
    },
    provider_unavailable: {
        localRetries: 1,
        backoff: 'none',
        failover: true,
        healthImpact: -15,
        countsAsError: true,
    },
    aborted: {
        localRetries: 0,
        backoff: 'none',
        failover: false,
        healthImpact: 0,
        countsAsError: false,
    },
    unknown: {
        localRetries: 1,
        backoff: 'exponential',
        failover: true,
        healthImpact: -5,
        countsAsError: true,
    },
};

const BASE_DELAY_MS: Readonly<Partial<Record<ProviderErrorCode, number>>> = {
    rate_limit: 1_000,
    network: 1_000,
    timeout: 2_000,
    unknown: 2_000,
};
const MAX_DELAY_MS = 4_000;

export function decisionForErrorCode(
    code: ProviderErrorCode,
    policy: RetryPolicyTable = DEFAULT_RETRY_POLICY,
): RetryDecision {
    return policy[code] ?? policy.unknown;
}

/**
 * 指数退避延迟（确定性，便于测试）。
 * rate_limit 优先取厂商 retryAfterMs（max(retryAfterMs, 指数序列)）；
 * 其余指数退避：min(base * 2^attempt, MAX_DELAY_MS)。
 */
export function retryDelayMs(
    code: ProviderErrorCode,
    attempt: number,
    opts: { retryAfterMs?: number; policy?: RetryPolicyTable } = {},
): number {
    const decision = decisionForErrorCode(code, opts.policy);
    if (decision.backoff === 'none') return 0;
    const base = BASE_DELAY_MS[code] ?? 2_000;
    const exponential = Math.min(base * 2 ** attempt, MAX_DELAY_MS);
    if (code === 'rate_limit' && opts.retryAfterMs !== undefined) {
        return Math.max(opts.retryAfterMs, exponential);
    }
    return exponential;
}

/** finishReason 特殊通道（§6.1）：insufficient_system_resource → provider_unavailable 行。 */
export function classifyFinishReason(finishReason: LLMFinishReason): ProviderErrorCode | null {
    if (finishReason === 'insufficient_system_resource') return 'provider_unavailable';
    return null;
}

// ------------------------------------------------------------
// CircuitBreaker（§6.2）
// ------------------------------------------------------------

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerStateSnapshot {
    state: BreakerState;
    consecutiveFailures: number;
    openedAt?: number;
}

export interface BreakerOptions {
    /** 连续 failover 类失败阈值 → open（默认 5） */
    consecutiveFailureThreshold?: number;
    /** 健康分 < 阈值 → open（默认 30） */
    healthThreshold?: number;
    /** open → half-open 冷却（默认 30_000ms） */
    cooldownMs?: number;
    clock?: () => number;
}

interface BreakerEntry {
    consecutiveFailures: number;
    openedAt?: number;
    /** half-open 探测在途 */
    probeInFlight: boolean;
}

/**
 * 端点级熔断器：decision 层与路由之间唯一回答「这个 provider 现在能不能用」。
 * healthScore 由调用方（路由/编排）在判定时刻注入，避免双重真相源。
 */
export class CircuitBreaker {
    private readonly entries = new Map<string, BreakerEntry>();
    private readonly opts: Required<Omit<BreakerOptions, 'clock'>> & { clock: () => number };

    constructor(options: BreakerOptions = {}) {
        this.opts = {
            consecutiveFailureThreshold: options.consecutiveFailureThreshold ?? 5,
            healthThreshold: options.healthThreshold ?? 30,
            cooldownMs: options.cooldownMs ?? 30_000,
            clock: options.clock ?? Date.now,
        };
    }

    private entry(providerId: string): BreakerEntry {
        let entry = this.entries.get(providerId);
        if (entry === undefined) {
            entry = { consecutiveFailures: 0, probeInFlight: false };
            this.entries.set(providerId, entry);
        }
        return entry;
    }

    state(providerId: string): BreakerState {
        const entry = this.entry(providerId);
        if (entry.openedAt === undefined) return 'closed';
        if (this.opts.clock() - entry.openedAt >= this.opts.cooldownMs) return 'half-open';
        return 'open';
    }

    snapshot(providerId: string): BreakerStateSnapshot {
        const entry = this.entry(providerId);
        return {
            state: this.state(providerId),
            consecutiveFailures: entry.consecutiveFailures,
            openedAt: entry.openedAt,
        };
    }

    /**
     * 请求前询问。open → 拒绝；half-open → 只放行一个探测请求（其余拒绝）；
     * closed → 放行（health < threshold 时直接拉 open）。
     */
    allow(providerId: string, healthScore: () => number): boolean {
        const state = this.state(providerId);
        if (state === 'open') return false;
        if (state === 'half-open') {
            const entry = this.entry(providerId);
            if (entry.probeInFlight) return false;
            // 冷却结束瞬间的健康分仍低于阈值 → 重新进入 open（重计冷却）
            if (healthScore() < this.opts.healthThreshold) {
                entry.openedAt = this.opts.clock();
                return false;
            }
            entry.probeInFlight = true;
            return true;
        }
        if (healthScore() < this.opts.healthThreshold) {
            this.open(providerId);
            return false;
        }
        return true;
    }

    /** 调用成功：清计数、关闭熔断。half-open 探测成功也走这里（健康 +20 由 HealthTracker 负责）。 */
    recordSuccess(providerId: string): void {
        const entry = this.entry(providerId);
        entry.consecutiveFailures = 0;
        entry.openedAt = undefined;
        entry.probeInFlight = false;
    }

    /** 调用失败（failover 类）：累计连续失败，超阈值 → open。 */
    recordFailure(providerId: string): void {
        const entry = this.entry(providerId);
        entry.consecutiveFailures += 1;
        entry.probeInFlight = false;
        if (entry.consecutiveFailures >= this.opts.consecutiveFailureThreshold) {
            this.open(providerId);
        }
    }

    private open(providerId: string): void {
        const entry = this.entry(providerId);
        entry.openedAt = this.opts.clock();
        entry.probeInFlight = false;
    }
}
