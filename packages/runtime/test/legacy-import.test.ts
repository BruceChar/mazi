import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteEventStore } from '../src/events/sqlite-event-store.js';
import {
    LEGACY_IMPORT_TYPES,
    importLegacyEvents,
    isImportableLegacyType,
    mapLegacyEvent,
} from '../src/events/legacy-import.js';

const AUDIT_TYPES = [
    'policy.check',
    'policy.denied',
    'approval.granted',
    'approval.requested',
    'approval.cancelled',
] as const;

const SKELETON_TYPES = [
    'goal.started',
    'goal.ended',
    'turn.started',
    'turn.ended',
    'goal.phase',
    'plan.created',
] as const;

function legacyRow(over: Record<string, unknown>): string {
    return JSON.stringify({
        type: 'policy.check',
        eventId: 'evt-missing',
        rootGoalId: 'rg-1',
        goalId: 'g-1',
        timestamp: 1700000000000,
        attributes: {},
        payload: { tool: 'fd' },
        ...over,
    });
}

describe('LEGACY_IMPORT_TYPES 迁移白名单', () => {
    it('含全部权限类与定位骨架，不含 stream_event / step', () => {
        for (const t of AUDIT_TYPES) expect(LEGACY_IMPORT_TYPES).toContain(t);
        for (const t of SKELETON_TYPES) expect(LEGACY_IMPORT_TYPES).toContain(t);
        expect(LEGACY_IMPORT_TYPES).not.toContain('llm.stream_event');
        expect(LEGACY_IMPORT_TYPES).not.toContain('step.started');
        expect(LEGACY_IMPORT_TYPES).not.toContain('step.ended');
    });

    it('isImportableLegacyType 仅认白名单', () => {
        for (const t of [...AUDIT_TYPES, ...SKELETON_TYPES]) {
            expect(isImportableLegacyType(t)).toBe(true);
        }
        for (const t of ['llm.stream_event', 'step.ended', 'tool.invoke', 'unknown.x', undefined, 42]) {
            expect(isImportableLegacyType(t)).toBe(false);
        }
    });
});

describe('mapLegacyEvent 旧记录映射', () => {
    it('透传既有标识与 payload，不注入 seq/hash', () => {
        const mapped = mapLegacyEvent(
            JSON.parse(
                legacyRow({
                    eventId: 'evt-1',
                    type: 'approval.granted',
                    sessionId: 'sess-9',
                    taskId: 't-1',
                    stepId: 'st-1',
                    payload: { key: 'k', decision: 'allowed' },
                }),
            ),
        );
        expect(mapped).toBeDefined();
        expect(mapped?.eventId).toBe('evt-1');
        expect(mapped?.type).toBe('approval.granted');
        expect(mapped?.rootGoalId).toBe('rg-1');
        expect(mapped?.sessionId).toBe('sess-9');
        expect(mapped?.goalId).toBe('g-1');
        expect(mapped?.taskId).toBe('t-1');
        expect(mapped?.stepId).toBe('st-1');
        expect(mapped?.payload).toEqual({ key: 'k', decision: 'allowed' });
        expect(mapped?.seq).toBeUndefined();
        expect(mapped?.hash).toBeUndefined();
        expect(mapped?.prevHash).toBeUndefined();
    });

    it('缺 eventId / rootGoalId / timestamp 返回 undefined', () => {
        expect(mapLegacyEvent(JSON.parse(legacyRow({ eventId: undefined })))).toBeUndefined();
        expect(mapLegacyEvent(JSON.parse(legacyRow({ rootGoalId: undefined })))).toBeUndefined();
        expect(mapLegacyEvent(JSON.parse(legacyRow({ timestamp: undefined })))).toBeUndefined();
    });

    it('非对象 / 坏数据返回 undefined', () => {
        expect(mapLegacyEvent(null)).toBeUndefined();
        expect(mapLegacyEvent([1, 2])).toBeUndefined();
        expect(mapLegacyEvent('policy.check')).toBeUndefined();
    });
});

describe('importLegacyEvents 扫描入库', () => {
    let dir: string;
    let dbPath: string;
    let store: SqliteEventStore;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'mazi-legacy-'));
        dbPath = join(dir, 'events.db');
        store = new SqliteEventStore(dbPath);
    });

    afterEach(() => {
        store.close();
        rmSync(dir, { recursive: true, force: true });
    });

    it('只入库白名单，跳过 stream_event / step / 坏行，重复 eventId 幂等', () => {
        const fileA = join(dir, 'goal-a.jsonl');
        writeFileSync(
            fileA,
            [
                legacyRow({ eventId: 'p1', type: 'policy.check', timestamp: 1700000000001 }),
                legacyRow({ eventId: 'd1', type: 'policy.denied', timestamp: 1700000000002 }),
                legacyRow({ eventId: 'g1', type: 'goal.started', timestamp: 1700000000003 }),
                legacyRow({ eventId: 's1', type: 'llm.stream_event', timestamp: 1700000000004 }),
                legacyRow({ eventId: 'st1', type: 'step.ended', timestamp: 1700000000005 }),
                '{bad json line',
                '',
            ].join('\n'),
            'utf8',
        );
        // 同 eventId 重复出现两次（跨文件/重跑），只计一行
        writeFileSync(
            join(dir, 'goal-b.jsonl'),
            [legacyRow({ eventId: 'p1', type: 'policy.check', timestamp: 1700000000001 })].join('\n'),
            'utf8',
        );

        const stats = importLegacyEvents(dir, store);
        expect(stats.scanned).toBe(7);
        expect(stats.imported).toBe(3);
        expect(stats.duplicates).toBe(1);
        expect(stats.skipped).toBe(3);

        const rows = store.query({ types: [...AUDIT_TYPES, ...SKELETON_TYPES] });
        expect(rows).toHaveLength(3);
        expect(rows.map((r) => r.eventId).sort()).toEqual(['d1', 'g1', 'p1']);
    });

    it('入库事件可按类型/根目标查询，payload 完整保留', () => {
        writeFileSync(
            join(dir, 'c.jsonl'),
            legacyRow({
                eventId: 'ap1',
                type: 'approval.requested',
                payload: { tool: 'rm', key: 'x' },
            }),
            'utf8',
        );
        importLegacyEvents(dir, store);
        const rows = store.query({ types: ['approval.requested'], rootGoalId: 'rg-1' });
        expect(rows).toHaveLength(1);
        expect(rows[0]?.payload).toEqual({ tool: 'rm', key: 'x' });
    });

    it('无 jsonl 的目录返回零统计不报错', () => {
        const empty = mkdtempSync(join(tmpdir(), 'mazi-legacy-empty-'));
        try {
            const stats = importLegacyEvents(empty, store);
            expect(stats.imported).toBe(0);
            expect(stats.scanned).toBe(0);
        } finally {
            rmSync(empty, { recursive: true, force: true });
        }
    });
});
