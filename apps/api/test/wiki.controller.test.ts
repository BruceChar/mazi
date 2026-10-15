import 'reflect-metadata';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestAppHandle } from '../src/testing/test-app.js';

/** 手写一份 wiki.md（与 runtime WikiStore 渲染格式一致），断言 API 只读视图。 */
function writeWiki(home: string, workspace: string, project: string): void {
    const dir = join(home, 'wiki', project);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
        join(dir, 'wiki.md'),
        [
            '# ' + project + ' 项目 wiki',
            '',
            '> 项目：' + project + ' ｜ 工作区：' + workspace + ' ｜ 最近更新：2026-10-16T02:13:40+08:00',
            '',
            '## 项目概览',
            'mazi 是 Agent Harness',
            '',
            '## 变更日志',
            '- 2026-10-16 02:13:40 | 新增项目 wiki 的读取与注入',
            '',
        ].join('\n'),
        'utf8',
    );
}

describe('项目 wiki 接口（docs/项目wiki设计.md §10）', () => {
    let h: TestAppHandle;
    const dirs: string[] = [];
    let workspace = '';
    let project = '';
    let emptyWorkspace = '';

    beforeAll(async () => {
        h = await createTestApp();
        workspace = mkdtempSync(join(tmpdir(), 'mazi-wikiws-'));
        emptyWorkspace = mkdtempSync(join(tmpdir(), 'mazi-wikiempty-'));
        dirs.push(workspace, emptyWorkspace);
        project = basename(workspace);
        writeWiki(h.home, workspace, project);
    });

    afterAll(async () => {
        await h.close();
        for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    it('W1 GET /api/wiki：返回快照 + 变更日志', async () => {
        const res = await h.fastify.inject({
            method: 'GET',
            url: '/api/wiki?workspace=' + encodeURIComponent(workspace),
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.project).toBe(project);
        expect(body.empty).toBe(false);
        expect(body.snapshot).toContain('mazi 是 Agent Harness');
        expect(body.entries).toHaveLength(1);
        expect(body.entries[0].change).toBe('新增项目 wiki 的读取与注入');
        expect(body.entries[0].ts).toBe('2026-10-16 02:13:40');
        expect(body.path).toBe(join(h.home, 'wiki', project, 'wiki.md'));
        expect(body.updatedAt).toBe('2026-10-16T02:13:40+08:00');
    });

    it('W2 未产生 wiki 的工作区：200 空态', async () => {
        const res = await h.fastify.inject({
            method: 'GET',
            url: '/api/wiki?workspace=' + encodeURIComponent(emptyWorkspace),
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.empty).toBe(true);
        expect(body.snapshot).toBeNull();
        expect(body.entries).toEqual([]);
    });

    it('W3 GET /api/wiki/list：项目清单含条目数与工作区', async () => {
        const res = await h.fastify.inject({ method: 'GET', url: '/api/wiki/list' });
        expect(res.statusCode).toBe(200);
        const list = res.json() as Array<{
            project: string;
            workspace: string;
            entries: number;
            updatedAt?: string;
        }>;
        const entry = list.find((item) => item.project === project);
        expect(entry).toBeTruthy();
        expect(entry?.entries).toBe(1);
        expect(entry?.workspace).toBe(workspace);
        expect(entry?.updatedAt).toBe('2026-10-16T02:13:40+08:00');
    });
});
