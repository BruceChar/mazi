import { describe, expect, it } from 'vitest';
import { HealthTracker } from '../../src/provider/health.js';

describe('HealthTracker（§8）', () => {
    it('初始 100；成功 +1 上限 100', () => {
        const h = new HealthTracker();
        expect(h.score('p1')).toBe(100);
        h.track('p1', { ok: true });
        expect(h.score('p1')).toBe(100);
    });

    it('失败按决策表 healthImpact 扣减', () => {
        const h = new HealthTracker();
        h.track('p1', { ok: false, errorCode: 'timeout' }); // -8
        expect(h.score('p1')).toBe(92);
        h.track('p1', { ok: false, errorCode: 'network' }); // -10
        expect(h.score('p1')).toBe(82);
        h.track('p1', { ok: false, errorCode: 'unknown' }); // -5
        expect(h.score('p1')).toBe(77);
    });

    it('auth 失败硬置 0（端点级硬摘除）', () => {
        const h = new HealthTracker();
        h.track('p1', { ok: false, errorCode: 'auth' });
        expect(h.score('p1')).toBe(0);
    });

    it('caller aborted 与 invalid_request 零影响', () => {
        const h = new HealthTracker();
        h.track('p1', { ok: false, errorCode: 'invalid_request' });
        h.track('p1', { ok: false, errorCode: 'aborted', abortedBy: 'caller' });
        expect(h.score('p1')).toBe(100);
        // timeout 定时器触发的 aborted 属 timeout 通道，计入扣减
        h.track('p1', { ok: false, errorCode: 'timeout', abortedBy: 'timeout' });
        expect(h.score('p1')).toBe(92);
    });

    it('context_length_exceeded 零影响（非厂商问题）', () => {
        const h = new HealthTracker();
        h.track('p1', { ok: false, errorCode: 'context_length_exceeded' });
        expect(h.score('p1')).toBe(100);
    });

    it('半开探测成功 +20', () => {
        const h = new HealthTracker();
        h.track('p1', { ok: false, errorCode: 'auth' });
        expect(h.score('p1')).toBe(0);
        h.probeSuccess('p1');
        expect(h.score('p1')).toBe(20);
    });

    it('synthetic（faux）轮次不更新健康', () => {
        const h = new HealthTracker();
        h.track('p1', { ok: false, errorCode: 'auth', synthetic: true });
        h.track('p1', { ok: true, synthetic: true });
        expect(h.score('p1')).toBe(100);
    });
});
