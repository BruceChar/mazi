import type { ProviderErrorCode } from '@mazi/core';
import { describe, expect, it } from 'vitest';
import {
    CircuitBreaker,
    classifyFinishReason,
    decisionForErrorCode,
    retryDelayMs,
} from '../../src/provider/retry.js';

describe('RetryPolicyTable（§6.1）', () => {
    it('每个错误码都有决策行（含默认回退 unknown）', () => {
        const codes: ProviderErrorCode[] = [
            'rate_limit',
            'context_length_exceeded',
            'auth',
            'timeout',
            'network',
            'invalid_request',
            'provider_unavailable',
            'aborted',
            'unknown',
        ];
        for (const code of codes) {
            const decision = decisionForErrorCode(code);
            expect(typeof decision.localRetries).toBe('number');
            expect(['none', 'exponential']).toContain(decision.backoff);
            expect(typeof decision.failover).toBe('boolean');
        }
        // rate_limit 可本地重试 + 可换家；invalid_request 直接冒泡
        expect(decisionForErrorCode('rate_limit').localRetries).toBe(2);
        expect(decisionForErrorCode('rate_limit').failover).toBe(true);
        expect(decisionForErrorCode('invalid_request').localRetries).toBe(0);
        expect(decisionForErrorCode('invalid_request').failover).toBe(false);
    });

    it('finishReason 特殊通道：insufficient_system_resource → provider_unavailable 行', () => {
        expect(classifyFinishReason('insufficient_system_resource')).toBe('provider_unavailable');
        expect(classifyFinishReason('stop')).toBeNull();
        expect(classifyFinishReason('tool_calls')).toBeNull();
    });

    it('指数退避确定性：rate_limit 优先 retryAfterMs；timeout/unknown 2s 基数，4s 封顶', () => {
        expect(retryDelayMs('rate_limit', 0)).toBe(1_000);
        expect(retryDelayMs('rate_limit', 0, { retryAfterMs: 500 })).toBe(1_000);
        expect(retryDelayMs('rate_limit', 0, { retryAfterMs: 5_000 })).toBe(5_000);
        expect(retryDelayMs('timeout', 0)).toBe(2_000);
        expect(retryDelayMs('timeout', 1)).toBe(4_000);
        expect(retryDelayMs('timeout', 2)).toBe(4_000); // 封顶
        expect(retryDelayMs('invalid_request', 0)).toBe(0); // backoff none
    });
});

describe('CircuitBreaker（§6.2）', () => {
    let clock = 0;
    const healthy = (): number => 100;
    const breaker = (): CircuitBreaker =>
        new CircuitBreaker({ clock: () => clock, cooldownMs: 30_000 });

    it('closed：连续 5 次 failover 类失败 → open 拒绝；成功后恢复 closed', () => {
        const cb = breaker();
        for (let i = 0; i < 4; i += 1) {
            expect(cb.allow('p1', healthy)).toBe(true);
            cb.recordFailure('p1');
        }
        expect(cb.state('p1')).toBe('closed');
        cb.recordFailure('p1'); // 第 5 次
        expect(cb.state('p1')).toBe('open');
        expect(cb.allow('p1', healthy)).toBe(false);
        cb.recordSuccess('p1');
        expect(cb.state('p1')).toBe('closed');
        expect(cb.allow('p1', healthy)).toBe(true);
    });

    it('half-open：冷却后只放一个探测；探测成功 → closed', () => {
        const cb = breaker();
        for (let i = 0; i < 5; i += 1) {
            cb.recordFailure('p2');
        }
        expect(cb.state('p2')).toBe('open');
        clock += 30_000;
        expect(cb.state('p2')).toBe('half-open');
        expect(cb.allow('p2', healthy)).toBe(true); // 探测放行
        expect(cb.allow('p2', healthy)).toBe(false); // 在途期间拒绝
        cb.recordSuccess('p2');
        expect(cb.state('p2')).toBe('closed');
        expect(cb.allow('p2', healthy)).toBe(true);
    });

    it('健康分低于阈值 → open；half-open 时仍低于阈值 → 重新 open', () => {
        const cb = breaker();
        expect(cb.allow('p3', () => 10)).toBe(false);
        expect(cb.state('p3')).toBe('open');
        clock += 30_000;
        expect(cb.allow('p3', () => 10)).toBe(false); // 重计冷却
        expect(cb.state('p3')).toBe('open');
        clock += 30_000; // 第二次冷却结束
        expect(cb.allow('p3', () => 90)).toBe(true); // 半开放行探测
    });

    it('连续失败计数在成功后清零', () => {
        const cb = breaker();
        cb.recordFailure('p4');
        cb.recordFailure('p4');
        cb.recordSuccess('p4');
        expect(cb.snapshot('p4').consecutiveFailures).toBe(0);
    });
});
