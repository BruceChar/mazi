import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ProjectWikiService } from '@mazi/runtime';
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
    const projectWiki = join(workspace, 'wiki');
    mkdirSync(join(projectWiki, 'overview'), { recursive: true });
    mkdirSync(join(projectWiki, 'state'), { recursive: true });
    writeFileSync(join(workspace, 'README.md'), '# Research\n', 'utf8');
    execFileSync('git', ['init', '-q'], { cwd: workspace });
    const oid = execFileSync('git', ['hash-object', '--', 'README.md'], {
        cwd: workspace,
        encoding: 'utf8',
    }).trim();
    writeFileSync(
        join(projectWiki, 'INDEX.md'),
        [
            '# ' + project,
            '',
            '> 项目摘要：研究项目的知识库',
            '> 项目类型：研究项目',
            '',
            '## 项目地图',
            '- 研究笔记 -> notes/',
        ].join('\n'),
        'utf8',
    );
    writeFileSync(
        join(projectWiki, 'overview', 'conventions.md'),
        '# 工作方式\n\n## 当前内容\n- 每周同步\n',
        'utf8',
    );
    writeFileSync(
        join(projectWiki, 'state', 'current.md'),
        '# 当前状态\n\n- 进行中：整理资料\n',
        'utf8',
    );
    writeFileSync(
        join(projectWiki, 'claims.toml'),
        [
            '# wiki/claims.toml',
            '',
            '[claims.research-cadence]',
            'text = "每周同步一次研究进展"',
            'status = "active"',
            'evidence = [',
            `  { file = "README.md", oid = "${oid}" },`,
            ']',
            'established = 2026-11-07',
            'verified = 2026-11-07',
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
    let v2OnlyWorkspace = '';
    let lifecycleWorkspace = '';

    beforeAll(async () => {
        h = await createTestApp();
        workspace = mkdtempSync(join(tmpdir(), 'mazi-wikiws-'));
        emptyWorkspace = mkdtempSync(join(tmpdir(), 'mazi-wikiempty-'));
        v2OnlyWorkspace = mkdtempSync(join(tmpdir(), 'mazi-wikiv2-'));
        lifecycleWorkspace = mkdtempSync(join(tmpdir(), 'mazi-wikilife-'));
        dirs.push(workspace, emptyWorkspace, v2OnlyWorkspace, lifecycleWorkspace);
        project = basename(workspace);
        writeWiki(h.home, workspace, project);
        writeWiki(h.home, lifecycleWorkspace, basename(lifecycleWorkspace));
        mkdirSync(join(v2OnlyWorkspace, 'wiki'), { recursive: true });
        writeFileSync(
            join(v2OnlyWorkspace, 'wiki', 'INDEX.md'),
            '# v2 only\n\n> 项目类型：研究项目\n',
            'utf8',
        );
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
        expect(body.blackboard.projectId).toBeTruthy();
        expect(body.blackboard.workspaceRef).toBe(workspace);
        expect(body.repository.root).toBe(workspace);
        expect(body.repository.docs.map((doc: { path: string }) => doc.path)).toEqual([
            'INDEX.md',
            'overview/conventions.md',
            'state/current.md',
        ]);
        expect(body.repository.index).toContain('研究项目的知识库');
        expect(body.repository.claims[0]).toMatchObject({
            id: 'research-cadence',
            status: 'active',
        });
        expect(body.repository.summary).toMatchObject({
            documents: 3,
            claims: 1,
            active: 1,
        });
        expect(body.operation).toBeNull();
        expect(body.backgroundSync).toBeNull();
    });

    it('W1b GET /api/wiki：claims 按工作区当前文件 oid 标记漂移', async () => {
        writeFileSync(join(workspace, 'README.md'), '# Research changed\n', 'utf8');
        const res = await h.fastify.inject({
            method: 'GET',
            url: '/api/wiki?workspace=' + encodeURIComponent(workspace),
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().repository.claims[0]).toMatchObject({
            id: 'research-cadence',
            status: 'stale',
        });
        expect(res.json().repository.summary.stale).toBe(1);
    });

    it('W1c GET /api/wiki：证据文件消失时标记 missing', async () => {
        unlinkSync(join(workspace, 'README.md'));
        const res = await h.fastify.inject({
            method: 'GET',
            url: '/api/wiki?workspace=' + encodeURIComponent(workspace),
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().repository.claims[0]).toMatchObject({
            id: 'research-cadence',
            status: 'missing',
        });
        expect(res.json().repository.summary.missing).toBe(1);
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
        expect(body.blackboard).toBeTruthy();
    });

    it('W2b 只有 repository wiki 时不再返回旧 wiki 空态', async () => {
        const res = await h.fastify.inject({
            method: 'GET',
            url: '/api/wiki?workspace=' + encodeURIComponent(v2OnlyWorkspace),
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.empty).toBe(false);
        expect(body.snapshot).toBeNull();
        expect(body.repository.docs[0].path).toBe('INDEX.md');
    });

    it('W4 POST /api/wiki/reconcile：项目知识对账仍从 Wiki 入口完成', async () => {
        const res = await h.fastify.inject({
            method: 'POST',
            url: '/api/wiki/reconcile?workspace=' + encodeURIComponent(workspace),
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().blackboard.projectId).toBeTruthy();
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

    it('W5 事实纠正会替代旧 claim，遗忘后退出后续上下文', async () => {
        const workspaceQuery = encodeURIComponent(lifecycleWorkspace);
        const corrected = await h.fastify.inject({
            method: 'POST',
            url: `/api/wiki/claims/research-cadence/correct?workspace=${workspaceQuery}`,
            payload: {
                newId: 'research-cadence-v2',
                text: '研究进展每两周同步一次',
                evidence: ['README.md'],
                reason: '协作节奏已调整',
            },
        });
        expect(corrected.statusCode).toBe(200);
        const afterCorrect = await h.fastify.inject({
            method: 'GET',
            url: `/api/wiki?workspace=${workspaceQuery}`,
        });
        expect(
            afterCorrect
                .json()
                .repository.claims.find((claim: { id: string }) => claim.id === 'research-cadence'),
        ).toMatchObject({
            status: 'retracted',
            retractionKind: 'corrected',
            supersededBy: 'research-cadence-v2',
        });
        expect(
            afterCorrect
                .json()
                .repository.claims.find(
                    (claim: { id: string }) => claim.id === 'research-cadence-v2',
                ),
        ).toMatchObject({ status: 'active', supersedes: 'research-cadence' });

        const forgotten = await h.fastify.inject({
            method: 'POST',
            url: `/api/wiki/claims/research-cadence-v2/forget?workspace=${workspaceQuery}`,
            payload: { reason: '用户要求忘记该研究节奏' },
        });
        expect(forgotten.statusCode).toBe(200);
        const afterForget = await h.fastify.inject({
            method: 'GET',
            url: `/api/wiki?workspace=${workspaceQuery}`,
        });
        expect(afterForget.json().repository.summary).toMatchObject({
            active: 0,
            retracted: 2,
            forgotten: 1,
        });
        expect(
            new ProjectWikiService({ workspace: lifecycleWorkspace }).promptFragment(),
        ).not.toContain('研究进展每两周同步一次');
    });
});
