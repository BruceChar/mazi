import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlBehaviorStore, MemoryBehaviorStore } from '../src/memory/behavior-store.js';

const dirs: string[] = [];
function tmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mazi-behavior-'));
    dirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('用户行为流 store（append-only + ts 单调守卫）', () => {
    it('Memory：按 max(base, last+1) 分配 ts，保留 ref/data', async () => {
        const store = new MemoryBehaviorStore(() => 100);
        const first = await store.append('rg', [{ type: 'input', data: { text: 'hi' } }]);
        expect(first[0]?.ts).toBe(100);

        const second = await store.append('rg', [
            { type: 'approval', ts: 50, data: { invocationId: 'i' } },
            {
                type: 'authorization',
                ref: { ts: first[0]?.ts ?? 0 },
                data: { decision: 'granted' },
            },
        ]);
        expect(second.map((view) => view.ts)).toEqual([101, 102]);
        expect(second[1]?.ref?.ts).toBe(100);
    });

    it('JSONL：文件头 + 逐行记录，跨实例可重载并续写', async () => {
        const dir = tmpDir();
        const store = new JsonlBehaviorStore(dir, () => 1000);
        await store.append('rg1', [{ type: 'input', data: { text: 'q' } }]);
        await store.append('rg1', [{ type: 'approval', data: { invocationId: 'i' } }]);
        store.close();

        const raw = readFileSync(join(dir, 'rg1.jsonl'), 'utf8').trim().split('\n');
        expect(raw).toHaveLength(3);
        expect(JSON.parse(raw[0] ?? '{}').format).toBe('user-behavior-stream');

        const reopened = new JsonlBehaviorStore(dir, () => 1001);
        const list = await reopened.list('rg1');
        expect(list.map((view) => view.type)).toEqual(['input', 'approval']);
        expect(list[0]?.ts).toBe(1000);

        const next = await reopened.append('rg1', [
            { type: 'feedback', data: { kind: 'text', text: 'x' } },
        ]);
        expect(next[0]?.ts).toBe(1002);
        reopened.close();
    });

    it('append-only：追加不重写历史字节', async () => {
        const dir = tmpDir();
        const store = new JsonlBehaviorStore(dir, () => 5);
        await store.append('rg', [{ type: 'input', data: { text: 'a' } }]);
        const before = readFileSync(join(dir, 'rg.jsonl'), 'utf8');
        await store.append('rg', [{ type: 'feedback', data: { kind: 'rating', rating: 1 } }]);
        const after = readFileSync(join(dir, 'rg.jsonl'), 'utf8');
        expect(after.startsWith(before)).toBe(true);
        store.close();
    });

    it('clear 删除分区文件与缓存', async () => {
        const dir = tmpDir();
        const store = new JsonlBehaviorStore(dir, () => 1);
        await store.append('rg', [{ type: 'input', data: { text: 'a' } }]);
        await store.clear('rg');
        expect(await store.list('rg')).toEqual([]);
        store.close();
    });
});
