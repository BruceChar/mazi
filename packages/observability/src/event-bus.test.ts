import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessEvent } from '@mazi/core';
import { ulid } from '@mazi/core';
import { afterEach, describe, expect, it } from 'vitest';
import { ConsoleSink, DefaultEventBus } from './event-bus';

const dirs: string[] = [];

function makeDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'mazi-obs-'));
    dirs.push(d);
    return d;
}

function ev(
    partial: Partial<HarnessEvent> & Pick<HarnessEvent, 'type' | 'sessionId'>,
): HarnessEvent {
    return { eventId: ulid(), timestamp: Date.now(), attributes: {}, ...partial };
}

afterEach(() => {
    for (const d of dirs.splice(0)) {
        // 清理由系统临时目录回收，这里不再主动删除
        void d;
    }
});

describe('DefaultEventBus（MVP v1.0 §8 F3）', () => {
    it('emit 后事件异步落盘为按 sessionId 分文件的 JSONL', async () => {
        const dir = makeDir();
        const bus = new DefaultEventBus({ eventDir: dir });
        const sessionId = 'sess-1';
        bus.emit(ev({ type: 'session.started', sessionId }));
        bus.emit(ev({ type: 'turn.started', sessionId, turnId: 't1' }));
        bus.emit(ev({ type: 'step.started', sessionId, turnId: 't1', stepId: 's1' }));
        await bus.flush();
        const file = join(dir, `${sessionId}.jsonl`);
        expect(existsSync(file)).toBe(true);
        const lines = readFileSync(file, 'utf8').trim().split('\n');
        expect(lines).toHaveLength(3);
        const parsed = lines.map((l) => JSON.parse(l) as HarnessEvent);
        expect(parsed.map((p) => p.type)).toEqual([
            'session.started',
            'turn.started',
            'step.started',
        ]);
        // 缺省 eventId/timestamp 自动补全
        for (const p of parsed) {
            expect(typeof p.eventId).toBe('string');
            expect(typeof p.timestamp).toBe('number');
        }
    });

    it('replay(sessionId) 从磁盘回放全部事件；跨 session 不串扰', async () => {
        const dir = makeDir();
        const bus = new DefaultEventBus({ eventDir: dir });
        bus.emit(ev({ type: 'session.started', sessionId: 'a' }));
        bus.emit(ev({ type: 'session.ended', sessionId: 'b' }));
        await bus.flush();
        const bus2 = new DefaultEventBus({ eventDir: dir });
        const replayA = bus2.replay('a');
        expect(replayA.map((e) => e.type)).toEqual(['session.started']);
        expect(bus2.replay('missing')).toEqual([]);
    });

    it('subscribe 按事件类型过滤，unsubscribe 后不再收到', async () => {
        const bus = new DefaultEventBus({ eventDir: makeDir() });
        const seen: HarnessEvent[] = [];
        const unsub = bus.subscribe(
            { types: ['session.ended'] },
            {
                id: 'tester',
                handle: (e) => void seen.push(e),
            },
        );
        bus.emit(ev({ type: 'session.started', sessionId: 's' }));
        bus.emit(ev({ type: 'session.ended', sessionId: 's' }));
        expect(seen.map((e) => e.type)).toEqual(['session.ended']);
        unsub();
        bus.emit(ev({ type: 'session.ended', sessionId: 's2' }));
        expect(seen).toHaveLength(1);
    });

    it('三层 ID 校验：缺 sessionId / Turn 级缺 turnId / Step 级缺 stepId 均抛错', () => {
        const bus = new DefaultEventBus({ eventDir: makeDir() });
        expect(() => bus.emit(ev({ type: 'session.started', sessionId: '' }))).toThrow(/sessionId/);
        expect(() => bus.emit(ev({ type: 'turn.started', sessionId: 's' }))).toThrow(/turnId/);
        expect(() => bus.emit(ev({ type: 'step.started', sessionId: 's', turnId: 't' }))).toThrow(
            /stepId/,
        );
        // session 级事件可缺省 turnId/stepId
        expect(() => bus.emit(ev({ type: 'session.started', sessionId: 'ok' }))).not.toThrow();
    });

    it('minLevel / requireFlag 过滤在 MVP 未实现，设置即 fail-fast 抛错', () => {
        const bus = new DefaultEventBus({ eventDir: makeDir() });
        expect(() =>
            bus.subscribe({ minLevel: 'info' }, { id: 'x', handle: () => undefined }),
        ).toThrow(/MVP/);
        expect(() =>
            bus.subscribe({ requireFlag: { key: 'a' } }, { id: 'x', handle: () => undefined }),
        ).toThrow(/MVP/);
    });

    it('ConsoleSink 可独立订阅，且不影响文件落盘', async () => {
        const dir = makeDir();
        const bus = new DefaultEventBus({ eventDir: dir });
        const logs: string[] = [];
        const orig = process.stdout.write;
        process.stdout.write = ((chunk: string | Uint8Array) => {
            logs.push(String(chunk));
            return true;
        }) as typeof process.stdout.write;
        try {
            bus.subscribe({}, new ConsoleSink());
            bus.emit(ev({ type: 'session.started', sessionId: 'console-sess' }));
            await bus.flush();
        } finally {
            process.stdout.write = orig;
        }
        expect(logs.length).toBe(1);
        expect(logs[0]).toContain('session.started');
        expect(existsSync(join(dir, 'console-sess.jsonl'))).toBe(true);
    });
});
