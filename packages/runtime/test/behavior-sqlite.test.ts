import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    JsonlBehaviorStore,
    migrateBehaviorJsonlToSqlite,
    SqliteBehaviorStore,
} from '../src/memory/behavior-store.js';

const dirs: string[] = [];
function tmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mazi-behavior-db-'));
    dirs.push(dir);
    return dir;
}
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('SqliteBehaviorStore（行为流权威库）', () => {
    it('append/list：单调 ts、ref/data 往返、跨实例持久化', async () => {
        const dbPath = join(tmpDir(), 'mazi.db');
        const store = new SqliteBehaviorStore(dbPath, () => 1000);
        await store.append('rg', [{ type: 'input', userId: 'me', data: { text: 'q' } }]);
        await store.append('rg', [
            {
                type: 'authorization',
                ts: 50,
                ref: { ts: 1000, anchor: { tokens: 3 } },
                data: { decision: 'granted' },
            },
        ]);
        const list = await store.list('rg');
        expect(list.map((v) => v.ts)).toEqual([1000, 1001]);
        expect(list[1]?.ref).toEqual({ ts: 1000, anchor: { tokens: 3 } });
        store.close();

        const reopened = new SqliteBehaviorStore(dbPath);
        expect((await reopened.list('rg')).map((v) => v.type)).toEqual(['input', 'authorization']);
        reopened.close();
    });

    it('clear 只删指定分区', async () => {
        const store = new SqliteBehaviorStore(join(tmpDir(), 'mazi.db'));
        await store.append('a', [{ type: 'input', data: { text: 'a' } }]);
        await store.append('b', [{ type: 'input', data: { text: 'b' } }]);
        await store.clear('a');
        expect(await store.list('a')).toEqual([]);
        expect((await store.list('b')).map((v) => v.data.text)).toEqual(['b']);
        store.close();
    });

    it('迁移：JSONL → SQLite 保序、幂等（确定性主键）', async () => {
        const dir = tmpDir();
        const behaviorDir = join(dir, 'behavior');
        const src = new JsonlBehaviorStore(behaviorDir, () => 100);
        await src.append('rg1', [{ type: 'input', data: { text: 'a' } }]);
        await src.append('rg1', [{ type: 'feedback', data: { kind: 'rating', rating: 5 } }]);
        await src.append('rg2', [{ type: 'input', data: { text: 'b' } }]);
        src.close();

        const dst = new SqliteBehaviorStore(join(dir, 'mazi.db'));
        expect(await migrateBehaviorJsonlToSqlite(behaviorDir, dst)).toEqual({
            partitions: 2,
            imported: 3,
        });
        expect((await dst.list('rg1')).map((v) => v.type)).toEqual(['input', 'feedback']);
        // 幂等：重复迁移不再导入。
        expect(await migrateBehaviorJsonlToSqlite(behaviorDir, dst)).toEqual({
            partitions: 0,
            imported: 0,
        });
        expect(await dst.list('rg1')).toHaveLength(2);
        dst.close();
    });
});
