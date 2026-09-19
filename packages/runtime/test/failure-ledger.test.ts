import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    type FailureLedgerEntry,
    MemoryFailureLedger,
    SqliteFailureLedger,
} from '../src/memory/failure-ledger.js';

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function entry(
    over: Pick<FailureLedgerEntry, 'failureId' | 'sessionId' | 'kind' | 'createdAt'> &
        Partial<FailureLedgerEntry>,
): FailureLedgerEntry {
    return over;
}

describe('failure-ledger store（失败分类账）', () => {
    it('Memory：createdAt 倒序、kind 过滤、limit、级联删除', async () => {
        const store = new MemoryFailureLedger();
        await store.add(
            entry({ failureId: 'f1', sessionId: 's1', kind: 'driver-error', createdAt: 1 }),
        );
        await store.add(entry({ failureId: 'f2', sessionId: 's1', kind: 'max-steps', createdAt: 3 }));
        await store.add(
            entry({ failureId: 'f3', sessionId: 's2', kind: 'driver-error', createdAt: 2 }),
        );

        expect((await store.list()).map((e) => e.failureId)).toEqual(['f2', 'f3', 'f1']);
        expect((await store.list({ kind: 'driver-error' })).map((e) => e.failureId)).toEqual([
            'f3',
            'f1',
        ]);
        expect((await store.list({ limit: 1 })).map((e) => e.failureId)).toEqual(['f2']);
        await store.deleteByRoot('s1');
        expect((await store.list()).map((e) => e.failureId)).toEqual(['f3']);
    });

    it('Sqlite：落盘、跨实例可读、kind 过滤、级联删除', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-ledger-'));
        dirs.push(dir);
        const dbPath = join(dir, 'test.db');
        const store = new SqliteFailureLedger(dbPath);
        await store.add(
            entry({
                failureId: 'f1',
                sessionId: 's1',
                kind: 'driver-error',
                summary: 'boom',
                createdAt: 1,
            }),
        );
        await store.add(entry({ failureId: 'f2', sessionId: 's1', kind: 'max-steps', createdAt: 2 }));
        store.close();

        const reopened = new SqliteFailureLedger(dbPath);
        expect((await reopened.list()).map((e) => e.failureId)).toEqual(['f2', 'f1']);
        expect((await reopened.list({ kind: 'driver-error' }))[0]?.summary).toBe('boom');
        await reopened.deleteByRoot('s1');
        expect(await reopened.list()).toEqual([]);
        reopened.close();
    });
});
