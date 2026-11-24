import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HarnessEvent } from '@mazi/core';
import { SqliteEventStore } from '../src/events/sqlite-event-store.js';

const dirs: string[] = [];
function tmpDb(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mazi-evdb-'));
    dirs.push(dir);
    return join(dir, 'events.db');
}
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function ev(over: Partial<HarnessEvent> & Pick<HarnessEvent, 'rootGoalId' | 'type'>): HarnessEvent {
    return {
        eventId: over.eventId ?? 'evt-' + Math.random().toString(36).slice(2, 8),
        timestamp: over.timestamp ?? Date.now(),
        attributes: {},
        ...over,
    } as HarnessEvent;
}

describe('SqliteEventStore', () => {
    it('append 后 replay 按 seq 升序返回，字段完整', () => {
        const store = new SqliteEventStore(tmpDb());
        store.append(ev({ rootGoalId: 'rg', type: 'policy.check', eventId: 'a', seq: 1, timestamp: 100, hash: 'h1', prevHash: 'g' }));
        store.append(ev({ rootGoalId: 'rg', type: 'approval.granted', eventId: 'b', seq: 2, timestamp: 200, hash: 'h2', prevHash: 'h1' }));
        const rows = store.replay('rg');
        expect(rows.map((r) => r.eventId)).toEqual(['a', 'b']);
        expect(rows[1]).toMatchObject({ type: 'approval.granted', seq: 2, hash: 'h2' });
        store.close();
    });

    it('query 按 type 与时间范围裁剪，不全表扫', () => {
        const store = new SqliteEventStore(tmpDb());
        store.append(ev({ rootGoalId: 'r1', type: 'policy.check', eventId: 'a', timestamp: 100 }));
        store.append(ev({ rootGoalId: 'r1', type: 'approval.granted', eventId: 'b', timestamp: 200 }));
        store.append(ev({ rootGoalId: 'r2', type: 'approval.granted', eventId: 'c', timestamp: 300 }));
        const granted = store.query({ types: ['approval.granted'] });
        expect(granted.map((r) => r.eventId).sort()).toEqual(['b', 'c']);
        const range = store.query({ types: ['approval.granted'], from: 150, to: 250 });
        expect(range.map((r) => r.eventId)).toEqual(['b']);
        const byRoot = store.query({ rootGoalId: 'r2' });
        expect(byRoot.map((r) => r.eventId)).toEqual(['c']);
        store.close();
    });

    it('同一 event_id 重复 append 去重，不产生两行', () => {
        const store = new SqliteEventStore(tmpDb());
        store.append(ev({ rootGoalId: 'rg', type: 'policy.check', eventId: 'a', seq: 1, timestamp: 100 }));
        store.append(ev({ rootGoalId: 'rg', type: 'policy.check', eventId: 'a', seq: 1, timestamp: 100 }));
        expect(store.replay('rg')).toHaveLength(1);
        store.close();
    });

    it('chainHead 返回最新 seq 与 hash', () => {
        const store = new SqliteEventStore(tmpDb());
        store.append(ev({ rootGoalId: 'rg', type: 'x', eventId: 'a', seq: 1, timestamp: 100, hash: 'h1' }));
        store.append(ev({ rootGoalId: 'rg', type: 'x', eventId: 'b', seq: 2, timestamp: 200, hash: 'h2' }));
        expect(store.chainHead('rg')).toEqual({ seq: 2, hash: 'h2' });
        expect(store.chainHead('missing')).toEqual({ seq: 0, hash: undefined });
        store.close();
    });
});
