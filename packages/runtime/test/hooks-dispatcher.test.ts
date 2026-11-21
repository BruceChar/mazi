import type { HookContext, HookPoint, HookRegistration } from '@mazi/core';
import { describe, expect, it } from 'vitest';
import { HookDispatcher } from '../src/hooks/dispatcher.js';

function ctx(point: HookPoint, payload: Record<string, unknown> = {}): HookContext {
    return { hookPoint: point, sessionId: 's1', rootGoalId: 'g1', payload };
}

function reg(
    id: string,
    point: HookPoint,
    handle: HookRegistration['handle'],
    extra: Partial<HookRegistration> = {},
): HookRegistration {
    return { id, point, handle, ...extra };
}

describe('HookDispatcher（§4.2 五种派发）', () => {
    it('waterfall 按 priority 顺序链式改写，后续 handler 能看到已累积 patch', async () => {
        const seen: Array<Record<string, unknown> | undefined> = [];
        const d = new HookDispatcher();
        d.register(
            reg('second', 'turn.start', async (c) => {
                seen.push(c.accumulated);
                return { kind: 'patch', patch: { contextAppend: 'B' } };
            }, { priority: 1 }),
        );
        d.register(
            reg('first', 'turn.start', async (c) => {
                seen.push(c.accumulated);
                return { kind: 'patch', patch: { contextAppend: 'A' } };
            }, { priority: 0 }),
        );
        const result = await d.invoke('turn.start', ctx('turn.start'), 'waterfall');
        expect(result.applied).toEqual(['first', 'second']);
        expect(seen[0]).toBeUndefined();
        expect(seen[1]).toEqual({ contextAppend: 'A' });
        expect(result.decision).toEqual({ kind: 'patch', patch: { contextAppend: 'B' } });
    });

    it('waterfall 遇到 block 立即短路（pre 点生效）', async () => {
        const calls: string[] = [];
        const d = new HookDispatcher();
        d.register(reg('guard', 'tool.pre', () => {
            calls.push('guard');
            return { kind: 'block', reason: 'unsafe command' };
        }));
        d.register(reg('later', 'tool.pre', () => {
            calls.push('later');
            return { kind: 'continue' };
        }));
        const result = await d.invoke('tool.pre', ctx('tool.pre'), 'waterfall');
        expect(calls).toEqual(['guard']);
        expect(result.decision).toEqual({ kind: 'block', reason: 'unsafe command' });
    });

    it('post 类点上的 block 降级为 continue/patch，不拦截主流程', async () => {
        const d = new HookDispatcher();
        d.register(reg('post', 'tool.post', () => ({ kind: 'block', reason: 'nope' })));
        const result = await d.invoke('tool.post', ctx('tool.post'), 'waterfall');
        expect(result.decision).toEqual({ kind: 'continue' });
    });

    it('bail 在首个 block 处停止，但 patch 可累积', async () => {
        const calls: string[] = [];
        const d = new HookDispatcher();
        d.register(reg('a', 'tool.pre', () => {
            calls.push('a');
            return { kind: 'patch', patch: { arguments: { path: 'x' } } };
        }));
        d.register(reg('b', 'tool.pre', () => {
            calls.push('b');
            return { kind: 'block', reason: 'blocked' };
        }));
        d.register(reg('c', 'tool.pre', () => {
            calls.push('c');
            return { kind: 'continue' };
        }));
        const result = await d.invoke('tool.pre', ctx('tool.pre'), 'bail');
        expect(calls).toEqual(['a', 'b']);
        expect(result.applied).toEqual(['a', 'b']);
        expect(result.decision).toEqual({ kind: 'block', reason: 'blocked' });
    });

    it('parallel 全部执行并按注册顺序合并 patch', async () => {
        const d = new HookDispatcher();
        d.register(reg('a', 'turn.end', async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return { kind: 'patch', patch: { summary: 'a' } };
        }));
        d.register(reg('b', 'turn.end', async () => ({ kind: 'patch', patch: { extra: 1 } })));
        const result = await d.invoke('turn.end', ctx('turn.end'), 'parallel');
        expect(result.applied).toEqual(['a', 'b']);
        expect(result.decision).toEqual({ kind: 'patch', patch: { summary: 'a', extra: 1 } });
    });

    it('serial 收集全部结果，异常被隔离为 failure', async () => {
        const d = new HookDispatcher();
        d.register(reg('ok', 'turn.end', () => ({ kind: 'patch', patch: { a: 1 } })));
        d.register(reg('boom', 'turn.end', () => {
            throw new Error('boom');
        }));
        const result = await d.invoke('turn.end', ctx('turn.end'), 'serial');
        expect(result.applied).toEqual(['ok', 'boom']);
        expect(result.decision).toEqual({ kind: 'patch', patch: { a: 1 } });
        expect(result.failures).toEqual([{ id: 'boom', mode: 'error', message: 'boom' }]);
    });

    it('emit 只广播、不收集决策', async () => {
        const d = new HookDispatcher();
        d.register(reg('noisy', 'llm.pre', () => ({ kind: 'patch', patch: { x: 1 } })));
        const result = await d.invoke('llm.pre', ctx('llm.pre'), 'emit');
        expect(result.applied).toEqual(['noisy']);
        expect(result.decision).toEqual({ kind: 'continue' });
    });

    it('超时记 timed_out 且默认不阻塞', async () => {
        const d = new HookDispatcher();
        d.register(
            reg('slow', 'tool.pre', () => new Promise(() => undefined), { timeoutMs: 5 }),
        );
        const result = await d.invoke('tool.pre', ctx('tool.pre'), 'bail');
        expect(result.failures[0]?.mode).toBe('timeout');
        expect(result.decision).toEqual({ kind: 'continue' });
    });

    it('onError=fail 的 pre handler 故障时 fail-closed', async () => {
        const d = new HookDispatcher();
        d.register(
            reg('guard', 'tool.pre', () => {
                throw new Error('policy service down');
            }, { onError: 'fail' }),
        );
        const result = await d.invoke('tool.pre', ctx('tool.pre'), 'bail');
        expect(result.decision.kind).toBe('block');
        if (result.decision.kind === 'block') {
            expect(result.decision.reason).toContain('policy service down');
        }
    });

    it('注册可撤销；重复 id 被拒绝', async () => {
        const d = new HookDispatcher();
        const off = d.register(reg('a', 'session.start', () => ({ kind: 'continue' })));
        expect(d.listenerCount('session.start')).toBe(1);
        expect(() => d.register(reg('a', 'session.start', () => undefined))).toThrow();
        off();
        expect(d.listenerCount('session.start')).toBe(0);
    });

    it('非法返回值按 failure 处理，不污染决策', async () => {
        const d = new HookDispatcher();
        d.register(
            reg('bad', 'tool.post', (() => ({ kind: 'block' })) as never),
        );
        const result = await d.invoke('tool.post', ctx('tool.post'), 'waterfall');
        expect(result.failures).toHaveLength(1);
        expect(result.decision).toEqual({ kind: 'continue' });
    });
});
