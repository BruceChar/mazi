/**
 * HealthTracker —— 实现 AHF_RUNTIME_PROVIDER §8。
 *
 * 规则（数值来自 §6.1 决策表，可替换）：
 *   1. 每次成功轮次 +1（缓慢恢复），上限 100；
 *   2. auth 失败直接置 0（端点级硬摘除）；其余失败按决策表 healthImpact 扣减；
 *   3. caller 主动 aborted 与 invalid_request 零影响；
 *   4. 半开探测成功 +20（§6.2）；
 *   5. synthetic（faux）轮次不更新画像/账本——健康同样跳过。
 * 健康分是 failover 与熔断的输入，不是路由评分组成部分。
 */

import type { ProviderErrorCode } from '@mazi/core';
import { DEFAULT_RETRY_POLICY, decisionForErrorCode, type RetryPolicyTable } from './retry.js';

export interface HealthOutcome {
    ok: boolean;
    errorCode?: ProviderErrorCode;
    /** §4.2 判断结果：caller / timeout */
    abortedBy?: 'caller' | 'timeout' | null;
    /** faux 轮次不进画像/账本（§9.3） */
    synthetic?: boolean;
}

const MIN_SCORE = 0;
const MAX_SCORE = 100;

export class HealthTracker {
    private readonly scores = new Map<string, number>();
    private readonly policy: RetryPolicyTable;

    constructor(policy: RetryPolicyTable = DEFAULT_RETRY_POLICY) {
        this.policy = policy;
    }

    score(providerId: string): number {
        return this.scores.get(providerId) ?? 100;
    }

    /** 一轮结束后的健康更新（§8 规则 1-5）。 */
    track(providerId: string, outcome: HealthOutcome): void {
        if (outcome.synthetic === true) return;
        if (outcome.ok) {
            this.bump(providerId, 1);
            return;
        }
        const code = outcome.errorCode;
        if (code === undefined) {
            // 无错误码的失败视为 unknown 行
            this.bump(providerId, this.policy.unknown.healthImpact);
            return;
        }
        if (outcome.abortedBy === 'caller' || code === 'invalid_request' || code === 'aborted') {
            return; // 我方取消 / 我方 bug：零影响
        }
        if (code === 'auth') {
            this.scores.set(providerId, MIN_SCORE); // 硬摘除
            return;
        }
        this.bump(providerId, decisionForErrorCode(code, this.policy).healthImpact);
    }

    /** 半开探测成功：+20（§8 规则 3 / §6.2）。 */
    probeSuccess(providerId: string): void {
        this.bump(providerId, 20);
    }

    private bump(providerId: string, delta: number): void {
        const next = Math.min(MAX_SCORE, Math.max(MIN_SCORE, this.score(providerId) + delta));
        this.scores.set(providerId, next);
    }
}
