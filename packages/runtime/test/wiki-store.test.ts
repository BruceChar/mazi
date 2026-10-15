import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
    buildWikiInjection,
    foldEntries,
    formatLocalTimestamp,
    parseWikiMarkdown,
    projectNameFor,
    renderWikiMarkdown,
    WIKI_LOG_HEADING,
    WikiStore,
} from '../src/wiki/index.js';

const roots: string[] = [];

function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    roots.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('wiki naming', () => {
    it('索引为空时用工作区目录名；同名不同路径追加短 hash', () => {
        const left = join(tempDir('mazi-a-'), 'proj');
        const right = join(tempDir('mazi-b-'), 'proj');
        expect(projectNameFor(left, {})).toBe('proj');
        const index = { proj: { workspace: left } };
        expect(projectNameFor(left, index)).toBe('proj');
        const renamed = projectNameFor(right, index);
        expect(renamed).not.toBe('proj');
        expect(renamed.startsWith('proj-')).toBe(true);
        expect(renamed.length).toBe('proj-'.length + 4);
    });
});

describe('wiki store', () => {
    it('快照可整体替换，变更日志只追加且保留时间列', async () => {
        const home = tempDir('mazi-home-');
        const workspace = tempDir('mazi-ws-');
        const store = new WikiStore({ home, workspace });

        await store.writeSnapshot('## 项目概览\n一句话定位', { sessionId: 's1' });
        await store.appendEntries([{ ts: '2026-10-16 02:13:40', change: '新增项目 wiki 的读取与注入' }]);
        await store.appendEntries(
            [{ ts: '2026-10-16 02:31:05', change: '修复会话结束后快照未刷新' }],
            { sessionId: 's2' },
        );

        const doc = store.read();
        expect(doc?.snapshot).toContain('一句话定位');
        expect(doc?.entries.map((entry) => entry.change)).toEqual([
            '新增项目 wiki 的读取与注入',
            '修复会话结束后快照未刷新',
        ]);
        expect(doc?.sessionId).toBe('s2');

        const raw = readFileSync(store.file, 'utf8');
        expect(raw).toContain('- 2026-10-16 02:13:40 | 新增项目 wiki 的读取与注入');
        expect(raw.indexOf('一句话定位')).toBeLessThan(raw.indexOf(WIKI_LOG_HEADING));

        // 再次替换快照不破坏日志区
        await store.writeSnapshot('## 项目概览\n新定位');
        const after = store.read();
        expect(after?.snapshot).toContain('新定位');
        expect(after?.entries).toHaveLength(2);

        // 项目索引落盘（API list 用）
        const index = JSON.parse(readFileSync(join(home, 'wiki', 'index.json'), 'utf8')) as Record<
            string,
            { workspace: string }
        >;
        expect(index[store.project]?.workspace).toBe(store.workspace);
    });

    it('损坏文件 → read 返回 undefined 且备份 .bak', async () => {
        const home = tempDir('mazi-home-');
        const workspace = tempDir('mazi-ws-');
        const store = new WikiStore({ home, workspace });
        await store.writeSnapshot('## 项目概览\nX');
        writeFileSync(store.file, 'not a wiki at all', 'utf8');
        expect(store.read()).toBeUndefined();
        expect(existsSync(store.file + '.bak')).toBe(true);
        expect(readFileSync(store.file + '.bak', 'utf8')).toBe('not a wiki at all');
    });

    it('foldEntries 超出上限折叠最旧条目', () => {
        const entry = (index: number) => ({ ts: 't' + index, change: 'c' + index });
        const folded = foldEntries([entry(1), entry(2), entry(3)], 2);
        expect(folded).toHaveLength(2);
        expect(folded[0]).toEqual({ ts: 't1', change: '更早 2 条变更已折叠' });
        expect(folded[1]).toEqual(entry(3));
        expect(foldEntries([entry(1)], 5)).toEqual([entry(1)]);
    });

    it('parse/render 往返保留头部与日志', () => {
        const raw = renderWikiMarkdown({
            project: 'mazi',
            workspace: '/tmp/mazi',
            updatedAt: '2026-10-16T02:13:40+08:00',
            snapshot: '## 项目概览\n定位',
            entries: [{ ts: '2026-10-16 02:13:40', change: '新增 A' }],
        });
        const doc = parseWikiMarkdown('mazi', '/tmp/mazi', raw);
        expect(doc.updatedAt).toBe('2026-10-16T02:13:40+08:00');
        expect(doc.snapshot).toContain('定位');
        expect(doc.entries).toEqual([{ ts: '2026-10-16 02:13:40', change: '新增 A' }]);
    });

    it('formatLocalTimestamp 输出人读时间列', () => {
        expect(formatLocalTimestamp(new Date(2026, 9, 16, 2, 13, 40))).toBe('2026-10-16 02:13:40');
    });
});

describe('wiki injector', () => {
    const doc = {
        project: 'mazi',
        workspace: '/tmp/mazi',
        updatedAt: '2026-10-16T02:13:40+08:00',
        snapshot: '## 项目概览\n定位\n\n## 进行中的工作\n- 做 A',
        entries: Array.from({ length: 12 }, (_, index) => ({
            ts: '2026-10-16 02:00:0' + (index % 10),
            change: '变更 ' + index,
        })),
    };

    it('无 wiki 注入提示句', () => {
        expect(buildWikiInjection(undefined)).toContain('本项目尚无 wiki');
    });

    it('有 wiki 注入快照分区与最近变更（默认 10 条）', () => {
        const fragment = buildWikiInjection(doc);
        expect(fragment).toContain('## 项目 wiki（mazi');
        expect(fragment).toContain('### 项目概览');
        expect(fragment).toContain('### 最近变更');
        expect(fragment).toContain('变更 11');
        expect(fragment).not.toContain('变更 0');
    });

    it('预算不足时标注截断', () => {
        const fragment = buildWikiInjection(doc, { budgetTokens: 5 });
        expect(fragment).toContain('（已截断，完整内容见 wiki.read）');
    });
});
