import { describe, expect, it } from 'vitest';
import { DEFAULT_FAULT_POLICY, FAULT_KINDS, defaultSeverityOf, isFaultKind } from '../src/index.js';

describe('fault 契约（docs/runtime/AHF_RUNTIME_FAULTS.md §3/§5）', () => {
    it('失败 kind 是闭集，且默认策略表覆盖每个 kind', () => {
        expect(FAULT_KINDS).toHaveLength(9);
        for (const kind of FAULT_KINDS) {
            expect(DEFAULT_FAULT_POLICY[kind]).toBeTruthy();
            expect(DEFAULT_FAULT_POLICY[kind].onGiveUp).toBeTruthy();
        }
        expect(isFaultKind('timeout')).toBe(true);
        expect(isFaultKind('nope')).toBe(false);
    });

    it('超时需要幂等前提，参数类错误不自动重试', () => {
        expect(DEFAULT_FAULT_POLICY.timeout.requiresIdempotent).toBe(true);
        expect(DEFAULT_FAULT_POLICY.timeout.maxRetries).toBe(1);
        expect(DEFAULT_FAULT_POLICY.invalid_args.maxRetries).toBe(0);
        expect(DEFAULT_FAULT_POLICY.invalid_args.onGiveUp).toBe('retry_altered');
        expect(DEFAULT_FAULT_POLICY.transient.maxRetries).toBe(2);
        expect(DEFAULT_FAULT_POLICY.transient.backoff).toBe('exponential');
    });

    it('只有 fatal 是致命严重度，权限与预算仍由策略表决定中止', () => {
        expect(defaultSeverityOf('fatal')).toBe('fatal');
        expect(defaultSeverityOf('policy_denied')).toBe('degradable');
        expect(defaultSeverityOf('budget_exhausted')).toBe('degradable');
        expect(defaultSeverityOf('timeout')).toBe('recoverable');
        expect(defaultSeverityOf('internal')).toBe('degradable');
    });
});
