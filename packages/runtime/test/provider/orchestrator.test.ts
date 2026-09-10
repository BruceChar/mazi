import type { LLMProvider, LLMRequest, StreamCompletionEvent } from '@mazi/core';
import { ProviderError } from '@mazi/core';
import { describe, expect, it } from 'vitest';
import { HealthTracker } from '../../src/provider/health.js';
import { estimateInputTokens, type RoundCandidate, RoundExecutor } from '../../src/provider/orchestrator.js';
import { CircuitBreaker, DEFAULT_RETRY_POLICY, type RetryPolicyTable } from '../../src/provider/retry.js';

/** 测试用策略表：关闭指数退避等待，保持测试即时 */
const FAST_POLICY: RetryPolicyTable = {
    ...DEFAULT_RETRY_POLICY,
    rate_limit: { ...DEFAULT_RETRY_POLICY.rate_limit, backoff: 'none' },
    network: { ...DEFAULT_RETRY_POLICY.network, backoff: 'none' },
    timeout: { ...DEFAULT_RETRY_POLICY.timeout, backoff: 'none' },
    unknown: { ...DEFAULT_RETRY_POLICY.unknown, backoff: 'none' },
};

const textEvents = (text: string): StreamCompletionEvent[] => [
    { type: 'start', model: 'm' },
    { type: 'text_delta', text },
    { type: 'finish', finishReason: 'stop' },
];

interface ScriptedStep {
    error?: ProviderError;
    events?: StreamCompletionEvent[];
    check?: (request: LLMRequest) => void;
    /** 若提供则 yield 后挂起至 signal 中止再抛 aborted */
    hangUntilAbort?: boolean;
}

function makeProvider(id: string, steps: ScriptedStep[]): LLMProvider {
    let call = 0;
    const provider: LLMProvider = {
        id,
        name: id,
        defaultModel: 'm',
        models: [],
        async ask(_request: LLMRequest) {
            throw new ProviderError('unknown', 'ask unused in orchestrator tests');
        },
        async *askStream(request: LLMRequest) {
            const step = steps[Math.min(call, steps.length - 1)];
            call += 1;
            step?.check?.(request);
            if (step?.error) throw step.error;
            for (const event of step?.events ?? []) yield event;
            if (step?.hangUntilAbort === true) {
                await new Promise<void>((resolve) => {
                    request.signal?.addEventListener('abort', () => resolve(), { once: true });
                });
                if (request.signal?.aborted) {
                    throw new ProviderError('aborted', 'request aborted while streaming');
                }
            }
        },
    };
    return provider;
}

const candidate = (
    providerId: string,
    provider: LLMProvider,
    over?: Partial<RoundCandidate>,
): RoundCandidate => ({
    providerId,
    provider,
    ...over,
});

const req: LLMRequest = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };

describe('RoundExecutor（§4）', () => {
    it('成功一轮：聚合响应 + metrics ok + attempts=1', async () => {
        const metrics: unknown[] = [];
        const health = new HealthTracker();
        const executor = new RoundExecutor({ onMetrics: (m) => metrics.push(m), health });
        const outcome = await executor.execute(req, [
            candidate('p', makeProvider('p', [{ events: textEvents('hello') }])),
        ]);
        expect(outcome.response.content).toEqual([{ type: 'text', text: 'hello' }]);
        expect(outcome.metrics.ok).toBe(true);
        expect(outcome.metrics.attempts).toBe(1);
        expect(outcome.attempts).toHaveLength(1);
        expect(metrics).toHaveLength(1);
        expect(health.score('p')).toBe(100);
    });

    it('本地重试：network 失败一次后成功，attempts=2，健康按 -10 扣减', async () => {
        const health = new HealthTracker();
        const executor = new RoundExecutor({ health, retryPolicy: FAST_POLICY });
        const provider = makeProvider('p', [
            { error: new ProviderError('network', 'conn refused') },
            { events: textEvents('ok') },
        ]);
        const outcome = await executor.execute(req, [candidate('p', provider)]);
        expect(outcome.metrics.attempts).toBe(2);
        expect(outcome.attempts[0]?.ok).toBe(false);
        expect(outcome.attempts[0]?.errorCode).toBe('network');
        expect(health.score('p')).toBe(91); // 失败 -10 后成功 +1
    });

    it('failover：candidate1 timeout 耗尽本地重试 → candidate2 成功', async () => {
        const executor = new RoundExecutor({ retryPolicy: FAST_POLICY });
        const p1 = makeProvider('p1', [
            { error: new ProviderError('timeout', 't1') },
            { error: new ProviderError('timeout', 't2') },
        ]);
        const p2 = makeProvider('p2', [{ events: textEvents('fallback ok') }]);
        const outcome = await executor.execute(req, [candidate('p1', p1), candidate('p2', p2)]);
        expect(outcome.metrics.ok).toBe(true);
        expect(outcome.metrics.providerId).toBe('p2');
        expect(outcome.metrics.attempts).toBe(3); // p1 两次 + p2 一次
    });

    it('熔断 open：跳过候选、attempts=0，最终 provider_unavailable', async () => {
        const breaker = new CircuitBreaker({ clock: () => 0 });
        for (let i = 0; i < 5; i += 1) breaker.recordFailure('p1');
        const executor = new RoundExecutor({ breaker });
        await expect(
            executor.execute(req, [
                candidate('p1', makeProvider('p1', [{ events: textEvents('x') }])),
            ]),
        ).rejects.toMatchObject({ code: 'provider_unavailable' });
    });

    it('finishReason 通道：insufficient_system_resource 本地重试后成功', async () => {
        const executor = new RoundExecutor({ retryPolicy: FAST_POLICY });
        const provider = makeProvider('p', [
            { events: [{ type: 'finish', finishReason: 'insufficient_system_resource' }] },
            { events: textEvents('ok') },
        ]);
        const outcome = await executor.execute(req, [candidate('p', provider)]);
        expect(outcome.metrics.ok).toBe(true);
        expect(outcome.metrics.attempts).toBe(2);
        expect(outcome.attempts[0]?.errorCode).toBe('provider_unavailable');
    });

    it('caller abort：直接冒泡 ProviderError(aborted)，健康零影响', async () => {
        const controller = new AbortController();
        controller.abort();
        const health = new HealthTracker();
        const executor = new RoundExecutor({ health, retryPolicy: FAST_POLICY });
        const provider = makeProvider('p', [
            {
                events: textEvents('never'),
                check: (request) => {
                    if (request.signal?.aborted)
                        throw new ProviderError('aborted', 'caller aborted');
                },
            },
        ]);
        await expect(
            executor.execute({ ...req, signal: controller.signal }, [candidate('p', provider)]),
        ).rejects.toMatchObject({ code: 'aborted' });
        expect(health.score('p')).toBe(100);
    });

    it('timeout 定时器：归类 timeout、health -8、log abortedBy=timeout', async () => {
        const health = new HealthTracker();
        const singleTimeoutPolicy: RetryPolicyTable = {
            ...FAST_POLICY,
            timeout: { ...FAST_POLICY.timeout, localRetries: 0 },
        };
        const executor = new RoundExecutor({ health, retryPolicy: singleTimeoutPolicy });
        const provider = makeProvider('p', [{ hangUntilAbort: true, events: [] }]);
        await expect(
            executor.execute(req, [candidate('p', provider, { timeoutMs: 15 })]),
        ).rejects.toMatchObject({ code: 'timeout' });
        expect(health.score('p')).toBe(92);
    });

    it('maxAttempts 封顶：unknown 重试上限内耗尽后冒泡', async () => {
        const executor = new RoundExecutor({ retryPolicy: FAST_POLICY, maxAttempts: 1 });
        const provider = makeProvider('p', [{ error: new ProviderError('unknown', 'boom') }]);
        await expect(executor.execute(req, [candidate('p', provider)])).rejects.toMatchObject({
            code: 'unknown',
        });
    });

    it('estimateInputTokens 粗估 > 0', () => {
        expect(estimateInputTokens(req)).toBeGreaterThan(0);
        expect(estimateInputTokens({ messages: [] })).toBeGreaterThanOrEqual(1);
    });
});
