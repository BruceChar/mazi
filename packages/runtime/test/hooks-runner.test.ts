import type { HarnessEvent } from '@mazi/core';
import { describe, expect, it } from 'vitest';
import { HookRunner } from '../src/hooks/runner.js';

function collector(): { events: HarnessEvent[]; emit: (event: HarnessEvent) => void } {
    const events: HarnessEvent[] = [];
    return { events, emit: (event) => events.push(event) };
}

describe('HookRunner（§4.3/§4.4 决策与审计）', () => {
    it('没有监听器时不产生审计事件', async () => {
        const sink = collector();
        const runner = new HookRunner({ emit: sink.emit });
        const result = await runner.invoke('tool.pre', {
            hookPoint: 'tool.pre',
            sessionId: 's1',
            rootGoalId: 'g1',
            payload: { toolName: 'shell.run' },
        });
        expect(result.applied).toEqual([]);
        expect(sink.events).toHaveLength(0);
    });

    it('有监听器时记 hook.invoked，block 再记 hook.decided', async () => {
        const sink = collector();
        const runner = new HookRunner({ emit: sink.emit });
        runner.register({
            id: 'guard',
            point: 'tool.pre',
            handle: () => ({ kind: 'block', reason: 'rm -rf blocked' }),
        });
        const result = await runner.invoke('tool.pre', {
            hookPoint: 'tool.pre',
            sessionId: 's1',
            rootGoalId: 'g1',
            goalId: 'g1',
            stepId: 'st1',
            payload: { toolName: 'shell.run' },
        });
        expect(result.decision).toEqual({ kind: 'block', reason: 'rm -rf blocked' });
        expect(sink.events.map((event) => event.type)).toEqual(['hook.invoked', 'hook.decided']);
        expect(sink.events[1]?.attributes['harness.level']).toBe('warn');
        expect(sink.events[1]?.attributes['harness.hook_point']).toBe('tool.pre');
        expect(sink.events[1]?.sessionId).toBe('s1');
        expect(sink.events[1]?.stepId).toBe('st1');
    });

    it('异常与超时分别记 hook.failed / hook.timed_out', async () => {
        const sink = collector();
        const runner = new HookRunner({ emit: sink.emit });
        runner.register({
            id: 'boom',
            point: 'turn.end',
            handle: () => {
                throw new Error('sidecar down');
            },
        });
        runner.register({
            id: 'slow',
            point: 'turn.end',
            timeoutMs: 5,
            handle: () => new Promise(() => undefined),
        });
        await runner.invoke('turn.end', {
            hookPoint: 'turn.end',
            sessionId: 's1',
            rootGoalId: 'g1',
            payload: {},
        });
        const types = sink.events.map((event) => event.type);
        expect(types).toContain('hook.failed');
        expect(types).toContain('hook.timed_out');
    });

    it('会话级调用没有 rootGoalId 时用会话锚点，事件信封不抛错', async () => {
        const sink = collector();
        const runner = new HookRunner({ emit: sink.emit });
        runner.register({
            id: 'mem',
            point: 'session.end',
            handle: () => ({ kind: 'continue' }),
        });
        await runner.invoke('session.end', {
            hookPoint: 'session.end',
            sessionId: 'sess-1',
            payload: { reason: 'conversation-removed' },
        });
        expect(sink.events[0]?.rootGoalId).toBe('session-sess-1');
        expect(sink.events[0]?.sessionId).toBe('sess-1');
    });

    it('审计出口抛错不影响主循环', async () => {
        const runner = new HookRunner({
            emit: () => {
                throw new Error('audit sink down');
            },
        });
        runner.register({
            id: 'x',
            point: 'tool.pre',
            handle: () => ({ kind: 'block', reason: 'no' }),
        });
        const result = await runner.invoke('tool.pre', {
            hookPoint: 'tool.pre',
            sessionId: 's1',
            rootGoalId: 'g1',
            payload: {},
        });
        expect(result.decision).toEqual({ kind: 'block', reason: 'no' });
    });
});
