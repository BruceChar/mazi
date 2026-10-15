import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
    type WikiChangeFacts,
    type WikiSnapshotInput,
    type WikiSummarizer,
    WikiStore,
    WikiWriter,
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

class CountingSummarizer implements WikiSummarizer {
    readonly calls: WikiChangeFacts[] = [];
    snapshotCalls = 0;

    async summarizeChanges(facts: WikiChangeFacts): Promise<string[]> {
        this.calls.push(facts);
        return ['新增项目 wiki 的变更记录'];
    }

    async refreshSnapshot(_input: WikiSnapshotInput): Promise<string | undefined> {
        this.snapshotCalls += 1;
        return '## 项目概览\n自动快照';
    }
}

function setup(options: { snapshotThreshold?: number } = {}) {
    const home = tempDir('mazi-home-');
    const workspace = tempDir('mazi-ws-');
    const store = new WikiStore({ home, workspace });
    const summarizer = new CountingSummarizer();
    const writer = new WikiWriter({
        store,
        workspace: store.workspace,
        summarizer,
        ...(options.snapshotThreshold !== undefined
            ? { snapshotThreshold: options.snapshotThreshold }
            : {}),
    });
    return { home, workspace, store, summarizer, writer };
}

describe('wiki writer', () => {
    it('写工具 pending + 回合末落一条『时间 | 改动』', async () => {
        const { store, writer, summarizer } = setup();
        await writer.beginRun();
        writer.record('fs.write', ['src/a.ts']);
        const result = await writer.flushRun({ sessionId: 's1', userRequest: '实现 A' });

        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].change).toBe('新增项目 wiki 的变更记录');
        expect(result.entries[0].ts).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
        expect(summarizer.calls).toHaveLength(1);
        expect(summarizer.calls[0].changedPaths).toContain('src/a.ts');
        expect(summarizer.calls[0].tools).toEqual(['fs.write']);

        const doc = store.read();
        expect(doc?.entries).toHaveLength(1);
        expect(doc?.sessionId).toBe('s1');
    });

    it('无改动 → 不调用摘要、不落条目，但仍落地项目概览快照', async () => {
        const { store, writer, summarizer } = setup();
        await writer.beginRun();
        const result = await writer.flushRun();
        expect(result.entries).toHaveLength(0);
        expect(summarizer.calls).toHaveLength(0);
        expect(store.read()?.snapshot).toContain('## 项目概览');
    });

    it('会话开始落地确定性项目概览，且不覆盖已有快照', async () => {
        const { workspace, store, writer } = setup();
        mkdirSync(join(workspace, 'packages', 'core'), { recursive: true });
        writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'demo' }), 'utf8');

        await writer.beginRun();
        const bootstrapped = store.read()?.snapshot ?? '';
        expect(bootstrapped).toContain('## 项目概览');
        expect(bootstrapped).toContain('## 结构与模块');
        expect(bootstrapped).toContain('packages/core');

        await store.writeSnapshot('## 项目概览\n人工快照');
        await writer.beginRun();
        expect(store.read()?.snapshot).toContain('人工快照');
    });

    it('兜底 diff 捕获 bash 等间接写入', async () => {
        const { workspace, writer, summarizer } = setup();
        mkdirSync(join(workspace, 'src'), { recursive: true });
        await writer.beginRun();
        writeFileSync(join(workspace, 'src', 'b.ts'), 'export const b = 1;\n', 'utf8');
        const result = await writer.flushRun();
        expect(result.entries).toHaveLength(1);
        expect(summarizer.calls[0].changedPaths).toContain('src/b.ts');
    });

    it('忽略 node_modules 等目录', async () => {
        const { workspace, writer, summarizer } = setup();
        mkdirSync(join(workspace, 'node_modules', 'dep'), { recursive: true });
        await writer.beginRun();
        writeFileSync(join(workspace, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
        const result = await writer.flushRun();
        expect(result.entries).toHaveLength(0);
        expect(summarizer.calls).toHaveLength(0);
    });

    it('累计变更达到阈值 → 刷新状态快照', async () => {
        const { store, writer, summarizer } = setup({ snapshotThreshold: 1 });
        await writer.beginRun();
        writer.record('fs.write', ['src/a.ts']);
        const result = await writer.flushRun();
        expect(result.snapshotRefreshed).toBe(true);
        expect(summarizer.snapshotCalls).toBe(1);
        expect(store.read()?.snapshot).toContain('自动快照');
        // 快照刷新不破坏刚追加的日志
        expect(store.read()?.entries).toHaveLength(1);
    });
});