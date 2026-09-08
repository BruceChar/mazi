import { describe, expect, it } from 'vitest';
import type { CollectableMetrics } from './profile.js';
import { ProfileCollector } from './profile.js';

let t = 0;
const now = (): number => t;
const metrics = (
    over: Partial<CollectableMetrics> & { providerId: string; modelId: string },
): CollectableMetrics => ({
    ok: true,
    totalMs: 200,
    attempts: 1,
    at: now(),
    ...over,
});

describe('ProfileCollector（§7）', () => {
    it('性能/经济画像：样本量、错误率、成本、token 平均', () => {
        const collector = new ProfileCollector({ windowMs: 1_000_000, now });
        collector.record(
            metrics({
                providerId: 'p',
                modelId: 'm',
                totalMs: 100,
                ttftMs: 20,
                costUsd: 0.01,
                usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
            }),
        );
        collector.record(
            metrics({
                providerId: 'p',
                modelId: 'm',
                totalMs: 300,
                ttftMs: 60,
                costUsd: 0.03,
                usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
            }),
        );
        const perf = collector.performance('p', 'm');
        const econ = collector.economics('p', 'm');
        expect(perf?.sampleSize).toBe(2);
        expect(econ?.sampleSize).toBe(2);
        expect(econ?.avgTaskCostUsd).toBeCloseTo(0.02, 6);
        expect(econ?.avgTokensPerTurn.input).toBeCloseTo(150, 6);
        expect(econ?.retryRate).toBe(0);
        expect(perf?.errorRate).toBe(0);
        expect(perf?.e2eLatencyMs.p50).toBe(100); // [100,300] → p50 = 排序后第 ceil(0.5*2)-1=0 位
    });

    it('错误与重试：errorRate、retryRate、tag 细分', () => {
        const collector = new ProfileCollector({ windowMs: 1_000_000, now });
        collector.record(
            metrics({
                providerId: 'p',
                modelId: 'm',
                ok: false,
                errorCode: 'network',
                attempts: 2,
                tags: ['code-refactoring'],
                at: 1,
            }),
        );
        collector.record(
            metrics({
                providerId: 'p',
                modelId: 'm',
                ok: true,
                attempts: 1,
                tags: ['code-refactoring'],
                at: 2,
                costUsd: 0.01,
            }),
        );
        const econ = collector.economics('p', 'm');
        expect(econ?.retryRate).toBe(0.5);
        expect(econ?.perTag?.['code-refactoring']?.sampleSize).toBe(2);
        const perf = collector.performance('p', 'm');
        expect(perf?.errorRate).toBe(0.5);
    });

    it('caller aborted 与 invalid_request 不计错误率', () => {
        const collector = new ProfileCollector({ windowMs: 1_000_000, now });
        collector.record(
            metrics({ providerId: 'p', modelId: 'm', ok: false, abortedBy: 'caller', at: 1 }),
        );
        collector.record(
            metrics({
                providerId: 'p',
                modelId: 'm',
                ok: false,
                errorCode: 'invalid_request',
                at: 2,
            }),
        );
        expect(collector.performance('p', 'm')?.errorRate).toBe(0);
    });

    it('窗口滚动淘汰：过期样本剔除后无数据 → null', () => {
        const collector = new ProfileCollector({ windowMs: 100, now });
        t = 0;
        collector.record(metrics({ providerId: 'p', modelId: 'm', at: 0 }));
        t = 500;
        collector.record(metrics({ providerId: 'p', modelId: 'm', at: 500 }));
        const perf = collector.performance('p', 'm');
        expect(perf?.sampleSize).toBe(1);
    });

    it('synthetic 不入画像', () => {
        const collector = new ProfileCollector({ windowMs: 1_000_000, now });
        collector.record(metrics({ providerId: 'p', modelId: 'm', synthetic: true, at: 1 }));
        expect(collector.performance('p', 'm')).toBeNull();
        expect(collector.economics('p', 'm')).toBeNull();
        expect(collector.snapshot().models).toEqual({});
    });

    it('snapshot() 往返包含画像', () => {
        const collector = new ProfileCollector({ windowMs: 1_000_000, now });
        collector.record(
            metrics({
                providerId: 'p',
                modelId: 'm',
                at: 1,
                costUsd: 0.001,
                usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            }),
        );
        const snap = collector.snapshot();
        expect(snap.models['p/m']).toBeDefined();
        expect(snap.models['p/m']?.performance.sampleSize).toBe(1);
    });
});
