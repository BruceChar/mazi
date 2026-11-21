import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionStreamId, ulid } from '@mazi/core';
import { afterEach, describe, expect, it } from 'vitest';
import { DefaultEventBus, newHarnessEvent } from '../src/events/index.js';

const dirs: string[] = [];

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeBus(dir: string, sessionOf?: (rootGoalId: string) => string | undefined): DefaultEventBus {
    return new DefaultEventBus({ eventDir: dir, ...(sessionOf ? { sessionOf } : {}) });
}

describe('会话坐标与事件流（docs/runtime/AHF_RUNTIME_KERNEL_AND_HOOKS.md §3）', () => {
    it('sessionOf 为执行事件补齐 sessionId，且不覆盖事件自带的会话', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-session-'));
        dirs.push(dir);
        const rootGoalId = ulid();
        const bus = makeBus(dir, (id) => (id === rootGoalId ? 'conv-1' : undefined));

        bus.emit(newHarnessEvent({ type: 'goal.started', rootGoalId, payload: {} }));
        bus.emit(
            newHarnessEvent({
                type: 'goal.ended',
                rootGoalId,
                sessionId: 'explicit-conv',
                payload: {},
            }),
        );
        await bus.flush();

        const [first, second] = bus.replay(rootGoalId);
        expect(first?.sessionId).toBe('conv-1');
        expect(second?.sessionId).toBe('explicit-conv');
    });

    it('会话级事件用锚点落盘并通过 replaySession 合并回放', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-session-'));
        dirs.push(dir);
        const sessionId = ulid();
        const rootGoalId = ulid();
        const anchor = sessionStreamId(sessionId);
        const bus = makeBus(dir, () => sessionId);

        bus.emit(
            newHarnessEvent({
                type: 'session.started',
                rootGoalId: anchor,
                sessionId,
                payload: {},
            }),
        );
        bus.emit(newHarnessEvent({ type: 'goal.started', rootGoalId, payload: {} }));
        bus.emit(
            newHarnessEvent({
                type: 'session.ended',
                rootGoalId: anchor,
                sessionId,
                payload: { reason: 'conversation-removed' },
            }),
        );
        await bus.flush();

        const events = bus.replaySession(sessionId);
        expect(events.map((event) => event.type)).toEqual([
            'session.started',
            'goal.started',
            'session.ended',
        ]);
        // 锚点流自身仍是有效哈希链。
        expect(bus.verifyChain(anchor).ok).toBe(true);
    });

    it('会话级事件缺少 sessionId 时不会误归到其他会话', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-session-'));
        dirs.push(dir);
        const other = ulid();
        const bus = makeBus(dir, () => other);
        bus.emit(
            newHarnessEvent({
                type: 'session.started',
                rootGoalId: sessionStreamId('conv-a'),
                sessionId: 'conv-a',
                payload: {},
            }),
        );
        await bus.flush();
        expect(bus.replaySession(other)).toEqual([]);
        expect(bus.replaySession('conv-a')).toHaveLength(1);
    });
});
