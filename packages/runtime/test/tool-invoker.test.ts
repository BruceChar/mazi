import type { Fault, FaultRecovery } from '@mazi/core';
import { describe, expect, it } from 'vitest';
import { DefaultFaultPipeline } from '../src/faults/index.js';
import { HookRunner } from '../src/hooks/index.js';
import { ToolInvoker, toolCallKey } from '../src/harness/tool-invoker.js';

const trace = { rootGoalId: 'root-1', goalId: 'goal-1' };

interface FakeGatewayOptions {
    /** 每次调用返回什么；用于模拟超时/异常/失败。 */
    handler: (attempt: number, args: Record<string, unknown>) => Promise<
        { ok: true; content: string } | { ok: false; error: string } | 'throw' | 'hang'
    >;
}

function fakeGateway(opts: FakeGatewayOptions): {
    port: {
        invoke: (
            tool: string,
            args: Record<string, unknown>,
            ctx: { stepId?: string; signal?: AbortSignal },
        ) => Promise<{ ok: boolean; content?: unknown; error?: string; retryable?: boolean }>;
    };
    calls: Array<{ args: Record<string, unknown>; signal?: AbortSignal }>;
} {
    const calls: Array<{ args: Record<string, unknown>; signal?: AbortSignal }> = [];
    return {
        calls,
        port: {
            async invoke(_tool, args, ctx) {
                calls.push({ args, ...(ctx.signal ? { signal: ctx.signal } : {}) });
                const result = await opts.handler(calls.length, args);
                if (result === 'throw') throw new Error('handler exploded');
                if (result === 'hang') {
                    await new Promise<void>((resolve) => {
                        ctx.signal?.addEventListener('abort', () => resolve(), { once: true });
                        setTimeout(resolve, 5_000);
                    });
                    return { ok: false, error: 'EXECUTION_FAILED: aborted' };
                }
                return 'ok' in result && result.ok
                    ? { ok: true, content: result.content }
                    : { ok: false, error: (result as { error: string }).error };
            },
        },
    };
}

function makeInvoker(
    gateway: ReturnType<typeof fakeGateway>['port'],
    opts: { timeoutMs?: number; faults?: DefaultFaultPipeline } = {},
): ToolInvoker {
    const events: Array<{ type: string; fault: Fault; recovery?: FaultRecovery }> = [];
    const faults =
        opts.faults ??
        new DefaultFaultPipeline({
            emit: (type, fault, recovery) => events.push({ type, fault, ...(recovery ? { recovery } : {}) }),
        });
    const hooks = new HookRunner({ emit: () => {} });
    return new ToolInvoker({
        ...trace,
        gateway,
        hooks,
        faults,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
}

describe('ToolInvoker（docs/runtime/AHF_RUNTIME_FAULTS.md §8）', () => {
    it('幂等工具超时后重试一次，仍失败则降级并回填观察', async () => {
        const gw = fakeGateway({ handler: async () => 'hang' });
        const invoker = makeInvoker(gw.port, { timeoutMs: 60 });
        const res = await invoker.invoke('fs.read', { path: 'a.md' });
        expect(res.ok).toBe(false);
        expect(res.error).toContain('TIMEOUT');
        expect(res.error).toContain('已尝试 2 次');
        expect(res.retryable).toBe(false);
        expect(gw.calls).toHaveLength(2);
        expect(gw.calls[0]?.signal?.aborted).toBe(true);
    });

    it('非幂等工具超时不重试', async () => {
        const gw = fakeGateway({ handler: async () => 'hang' });
        const invoker = makeInvoker(gw.port, { timeoutMs: 60 });
        const res = await invoker.invoke('shell.run', { cmd: ['rm'] });
        expect(res.ok).toBe(false);
        expect(gw.calls).toHaveLength(1);
        expect(res.error).toContain('非幂等');
    });

    it('参数错误零重试，观察里带缺少字段', async () => {
        const gw = fakeGateway({
            handler: async () => ({ ok: false, error: 'INVALID_ARGS: 缺少必填参数：path' }),
        });
        const invoker = makeInvoker(gw.port);
        const res = await invoker.invoke('fs.read', {});
        expect(res.ok).toBe(false);
        expect(res.code).toBe('INVALID_ARGS');
        expect(res.retryable).toBe(true);
        expect(res.error).toContain('INVALID_ARGS');
        expect(gw.calls).toHaveLength(1);
    });

    it('网关抛出收敛为 internal 观察，绝不冒泡', async () => {
        const gw = fakeGateway({ handler: async () => 'throw' });
        const invoker = makeInvoker(gw.port);
        await expect(invoker.invoke('fs.read', { path: 'a' })).resolves.toMatchObject({
            ok: false,
            code: 'EXECUTION_FAILED',
        });
    });

    it('hook 拦截直接返回，不执行工具', async () => {
        const faults = new DefaultFaultPipeline();
        const hooks = new HookRunner({ emit: () => {} });
        hooks.register({
            id: 'blocker',
            point: 'tool.pre',
            handle: () => ({ kind: 'block', reason: '策略禁止' }),
        });
        const gw = fakeGateway({ handler: async () => ({ ok: true, content: 'x' }) });
        const invoker = new ToolInvoker({ ...trace, gateway: gw.port, hooks, faults });
        const res = await invoker.invoke('fs.read', { path: 'a' });
        expect(res).toMatchObject({ ok: false, code: 'HOOK_BLOCKED' });
        expect(gw.calls).toHaveLength(0);
    });

    it('同一调用失败后成功：计数清零并广播 fault.recovered', async () => {
        const events: string[] = [];
        const faults = new DefaultFaultPipeline({
            emit: (type) => events.push(type),
        });
        const gw = fakeGateway({
            handler: async (attempt) =>
                attempt === 1 ? 'hang' : { ok: true, content: '读到了' },
        });
        const invoker = makeInvoker(gw.port, { timeoutMs: 60, faults });
        const res = await invoker.invoke('fs.read', { path: 'a.md' });
        expect(res).toMatchObject({ ok: true, content: '读到了' });
        expect(events).toEqual(['fault.raised', 'fault.recovered']);
        expect(faults.attemptsOf(toolCallKey('fs.read', { path: 'a.md' }))).toBe(0);
    });
});
