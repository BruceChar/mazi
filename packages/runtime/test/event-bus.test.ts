import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessEvent } from '@mazi/core';
import { ulid } from '@mazi/core';
import { afterEach, describe, expect, it } from 'vitest';
import { ConsoleSink, DefaultEventBus } from '../src/events/event-bus.js';
import { SqliteEventStore } from '../src/events/sqlite-event-store.js';

const dirs: string[] = [];

function makeStore(): SqliteEventStore {
    const dir = mkdtempSync(join(tmpdir(), 'mazi-obs-'));
    dirs.push(dir);
    return new SqliteEventStore(join(dir, 'events.db'));
}

function ev(
    partial: Partial<HarnessEvent> & Pick<HarnessEvent, 'type' | 'rootGoalId'>,
): HarnessEvent {
    return { eventId: ulid(), timestamp: Date.now(), attributes: {}, ...partial };
}

afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('DefaultEventBus（MVP v1.0 §8 F3）', () => {
    it('emit 后事件异步入库，replay 按 seq 顺序取回并补全 eventId/timestamp', async () => {
        const store = makeStore();
        const bus = new DefaultEventBus({ store });
        const rootGoalId = ulid();
        const goalId = ulid();
        const taskId = ulid();
        const stepId = ulid();
        bus.emit(ev({ type: 'goal.started', rootGoalId, goalId }));
        bus.emit(ev({ type: 'task.started', rootGoalId, goalId, taskId }));
        bus.emit(ev({ type: 'step.started', rootGoalId, goalId, taskId, stepId }));
        await bus.flush();
        const replay = bus.replay(rootGoalId);
        expect(replay.map((e) => e.type)).toEqual(['goal.started', 'task.started', 'step.started']);
        for (const e of replay) {
            expect(typeof e.eventId).toBe('string');
            expect(typeof e.timestamp).toBe('number');
        }
    });

    it('replay(rootGoalId) 从库回放；跨 root goal 不串扰，新总线同库可重读', async () => {
        const store = makeStore();
        const bus = new DefaultEventBus({ store });
        const rootA = ulid();
        const rootB = ulid();
        bus.emit(ev({ type: 'goal.started', rootGoalId: rootA }));
        bus.emit(ev({ type: 'goal.ended', rootGoalId: rootB }));
        await bus.flush();
        const bus2 = new DefaultEventBus({ store });
        expect(bus2.replay(rootA).map((e) => e.type)).toEqual(['goal.started']);
        expect(bus2.replay(ulid())).toEqual([]);
    });

    it('subscribe 按事件类型过滤，unsubscribe 后不再收到', () => {
        const bus = new DefaultEventBus({ store: makeStore() });
        const seen: HarnessEvent[] = [];
        const unsub = bus.subscribe(
            { types: ['goal.ended'] },
            {
                id: 'tester',
                handle: (e) => void seen.push(e),
            },
        );
        const rootA = ulid();
        const rootB = ulid();
        bus.emit(ev({ type: 'goal.started', rootGoalId: rootA }));
        bus.emit(ev({ type: 'goal.ended', rootGoalId: rootA }));
        expect(seen.map((e) => e.type)).toEqual(['goal.ended']);
        unsub();
        bus.emit(ev({ type: 'goal.ended', rootGoalId: rootB }));
        expect(seen).toHaveLength(1);
    });

    it('四层 ID 校验：缺 rootGoalId / Task 级缺 taskId / Step 级缺 stepId 均抛错', () => {
        const bus = new DefaultEventBus({ store: makeStore() });
        expect(() => bus.emit(ev({ type: 'goal.started', rootGoalId: '' }))).toThrow(/rootGoalId/);
        expect(() => bus.emit(ev({ type: 'task.started', rootGoalId: ulid() }))).toThrow(/taskId/);
        expect(() =>
            bus.emit(ev({ type: 'step.started', rootGoalId: ulid(), taskId: ulid() })),
        ).toThrow(/stepId/);
        // goal 级事件可缺省 taskId/stepId
        expect(() => bus.emit(ev({ type: 'goal.started', rootGoalId: ulid() }))).not.toThrow();
    });

    it('为每个 root goal 生成可独立校验的 seq/hash 链，并能定位断档篡改', async () => {
        const store = makeStore();
        const bus = new DefaultEventBus({ store });
        const rootGoalId = ulid();
        bus.emit(ev({ type: 'goal.started', rootGoalId }));
        bus.emit(ev({ type: 'goal.ended', rootGoalId, causedBy: 'cause-1', actor: 'human' }));
        await bus.flush();

        const replay = bus.replay(rootGoalId);
        expect(replay.map((event) => event.seq)).toEqual([1, 2]);
        expect(replay[1]?.prevHash).toBe(replay[0]?.hash);
        expect(replay[1]).toMatchObject({ causedBy: 'cause-1', actor: 'human' });
        expect(bus.verifyChain(rootGoalId)).toMatchObject({ ok: true, verified: 2, legacy: 0 });

        // 断档篡改：手工补一条 seq=5 的事件，链在 seq=2 后期望 3，立即报断档。
        store.append(
            ev({ type: 'tool.invoke', rootGoalId, eventId: 'evil', seq: 5, timestamp: 300, prevHash: 'x', hash: 'y' }),
        );
        expect(bus.verifyChain(rootGoalId)).toMatchObject({
            ok: false,
            code: 'AUDIT_TAMPER_SUSPECTED',
        });
    });

    it('minLevel / requireFlag 过滤在 MVP 未实现，设置即 fail-fast 抛错', () => {
        const bus = new DefaultEventBus({ store: makeStore() });
        expect(() =>
            bus.subscribe({ minLevel: 'info' }, { id: 'x', handle: () => undefined }),
        ).toThrow(/MVP/);
        expect(() =>
            bus.subscribe({ requireFlag: { key: 'a' } }, { id: 'x', handle: () => undefined }),
        ).toThrow(/MVP/);
    });

    it('ConsoleSink 可独立订阅，且不影响入库分发', () => {
        const bus = new DefaultEventBus({ store: makeStore() });
        const logs: string[] = [];
        const orig = process.stdout.write;
        process.stdout.write = ((chunk: string | Uint8Array) => {
            logs.push(String(chunk));
            return true;
        }) as typeof process.stdout.write;
        const rootGoalId = ulid();
        try {
            bus.subscribe({}, new ConsoleSink());
            bus.emit(ev({ type: 'goal.started', rootGoalId }));
        } finally {
            process.stdout.write = orig;
        }
        expect(logs.length).toBe(1);
        expect(logs[0]).toContain('goal.started');
    });
});
