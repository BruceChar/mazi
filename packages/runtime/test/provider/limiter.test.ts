import { describe, expect, it } from 'vitest';
import { EndpointLimiter, msUntilTokens, refillBucket } from '../../src/provider/limiter.js';

const limits = new Map<string, { rpm?: number; tpm?: number; concurrency?: number }>();
const fakeLimits = (providerId: string) => limits.get(providerId);

function makeLimiter(now: () => number, sleeper: (ms: number) => Promise<void>): EndpointLimiter {
    return new EndpointLimiter({ limits: fakeLimits, now, sleep: sleeper });
}

describe('令牌桶纯函数（§4.3）', () => {
    it('refillBucket 按速率匀速回填并封顶容量', () => {
        expect(refillBucket({ tokens: 0, lastRefill: 0 }, 60, 60, 30_000)).toEqual({
            tokens: 30,
            lastRefill: 30_000,
        });
        expect(refillBucket({ tokens: 59, lastRefill: 0 }, 60, 60, 120_000)).toEqual({
            tokens: 60,
            lastRefill: 120_000,
        });
    });

    it('msUntilTokens 按缺失量换算等待毫秒', () => {
        const bucket = { tokens: 10, lastRefill: 0 };
        expect(msUntilTokens(bucket, 60, 10, 0)).toBe(0);
        expect(msUntilTokens(bucket, 60, 20, 0)).toBeGreaterThan(0);
        expect(msUntilTokens(bucket, 0, 20, 0)).toBe(0); // 无该维度限额
    });
});

describe('EndpointLimiter', () => {
    it('额度充足时直接放行并扣减 rpm/tpm', async () => {
        limits.set('p1', { rpm: 100, tpm: 10_000, concurrency: 4 });
        const limiter = makeLimiter(
            () => 0,
            async () => undefined,
        );
        await limiter.acquire('p1', 100);
        const snap = limiter.snapshot('p1');
        expect(snap.inFlight).toBe(1);
        expect(snap.rpmTokens).toBeCloseTo(99, 6);
        expect(snap.tpmTokens).toBeCloseTo(9_900, 6);
    });

    it('并发占满时阻塞，settle 释放槽位', async () => {
        limits.set('p1', { tpm: 10_000, concurrency: 1 });
        const limiter = new EndpointLimiter({ limits: fakeLimits }); // 真实时间，轮询等待
        await limiter.acquire('p1', 0);
        expect(limiter.snapshot('p1').inFlight).toBe(1);
        const pending = limiter.acquire('p1', 0); // 并发占满 → 阻塞轮询
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(limiter.snapshot('p1').inFlight).toBe(1); // 仍未放行
        limiter.settle('p1', { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
        await pending; // 槽位释放后放行
        expect(limiter.snapshot('p1').inFlight).toBe(1);
    });

    it('tpm 预估-实际修正：多估回补、少估补扣', async () => {
        limits.set('p1', { tpm: 10_000 });
        const limiter = makeLimiter(
            () => 0,
            async () => undefined,
        );
        await limiter.acquire('p1', 1_000);
        expect(limiter.snapshot('p1').tpmTokens).toBeCloseTo(9_000, 6);
        limiter.settle('p1', { inputTokens: 800, outputTokens: 0, totalTokens: 800 });
        expect(limiter.snapshot('p1').tpmTokens).toBeCloseTo(9_200, 6); // 回补 200
        await limiter.acquire('p1', 1_000); // 9_200 − 1_000 = 8_200
        limiter.settle('p1', { inputTokens: 1_300, outputTokens: 0, totalTokens: 1_300 });
        expect(limiter.snapshot('p1').tpmTokens).toBeCloseTo(7_900, 6); // 再补扣 300
    });
});
