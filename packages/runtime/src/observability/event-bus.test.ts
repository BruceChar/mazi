import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessEvent } from '@mazi/core';
import { ulid } from '@mazi/core';
import { afterEach, describe, expect, it } from 'vitest';
import { ConsoleSink, DefaultEventBus } from './event-bus.js';

const dirs: string[] = [];

function makeDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'mazi-obs-'));
    dirs.push(d);
    return d;
}

function ev(
    partial: Partial<HarnessEvent> & Pick<HarnessEvent, 'type' | 'rootGoalId'>,
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
    it('emit 后事件异步落盘为按 rootGoalId 分文件的 JSONL', async () => {
        const dir = makeDir();
        const bus = new DefaultEventBus({ eventDir: dir });
        const rootGoalId = ulid();
        const goalId = ulid();
        const taskId = ulid();
        const stepId = ulid();
        bus.emit(ev({ type: 'goal.started', rootGoalId, goalId }));
        bus.emit(ev({ type: 'task.started', rootGoalId, goalId, taskId }));
        bus.emit(ev({ type: 'step.started', rootGoalId, goalId, taskId, stepId }));
        await bus.flush();
        const file = join(dir, `${rootGoalId}.jsonl`);
        expect(existsSync(file)).toBe(true);
        const lines = readFileSync(file, 'utf8').trim().split('\n');
        expect(lines).toHaveLength(3);
        const parsed = lines.map((l) => JSON.parse(l) as HarnessEvent);
        expect(parsed.map((p) => p.type)).toEqual([
            'goal.started',
            'task.started',
            'step.started',
        ]);
        // 缺省 eventId/timestamp 自动补全
        for (const p of parsed) {
            expect(typeof p.eventId).toBe('string');
            expect(typeof p.timestamp).toBe('number');
        }
    });

    it('replay(rootGoalId) 从磁盘回放全部事件；跨 root goal 不串扰', async () => {
        const dir = makeDir();
        const bus = new DefaultEventBus({ eventDir: dir });
        const rootA = ulid();
        const rootB = ulid();
        bus.emit(ev({ type: 'goal.started', rootGoalId: rootA }));
        bus.emit(ev({ type: 'goal.ended', rootGoalId: rootB }));
        await bus.flush();
        const bus2 = new DefaultEventBus({ eventDir: dir });
        const replayA = bus2.replay(rootA);
        expect(replayA.map((e) => e.type)).toEqual(['goal.started']);
        expect(bus2.replay(ulid())).toEqual([]);
    });

    it('subscribe 按事件类型过滤，unsubscribe 后不再收到', async () => {
        const bus = new DefaultEventBus({ eventDir: makeDir() });
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
        const bus = new DefaultEventBus({ eventDir: makeDir() });
        expect(() => bus.emit(ev({ type: 'goal.started', rootGoalId: '' }))).toThrow(/rootGoalId/);
        expect(() => bus.emit(ev({ type: 'task.started', rootGoalId: ulid() }))).toThrow(/taskId/);
        expect(() =>
            bus.emit(ev({ type: 'step.started', rootGoalId: ulid(), taskId: ulid() })),
        ).toThrow(/stepId/);
        // goal 级事件可缺省 taskId/stepId
        expect(() => bus.emit(ev({ type: 'goal.started', rootGoalId: ulid() }))).not.toThrow();
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
        const rootGoalId = ulid();
        try {
            bus.subscribe({}, new ConsoleSink());
            bus.emit(ev({ type: 'goal.started', rootGoalId }));
            await bus.flush();
        } finally {
            process.stdout.write = orig;
        }
        expect(logs.length).toBe(1);
        expect(logs[0]).toContain('goal.started');
        expect(existsSync(join(dir, `${rootGoalId}.jsonl`))).toBe(true);
    });
});
