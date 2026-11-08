import { execFileSync } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
    ProjectWikiService,
    readProjectWiki,
} from '../src/wiki/index.js';

const roots: string[] = [];

function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    roots.push(dir);
    return dir;
}

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function repo(): string {
    const root = tempDir('mazi-project-wiki-');
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'project-wiki@example.com');
    git(root, 'config', 'user.name', 'Project Wiki Test');
    writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'fixture', scripts: { check: 'echo ok' } }),
        'utf8',
    );
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'config.ts'), 'export const port = 8787;\n', 'utf8');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '--no-verify', '-m', 'initial');
    return root;
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('runtime Project Wiki', () => {
    it('初始化领域中立 Wiki，重复 init 不覆盖已有文档', async () => {
        const root = repo();
        const wiki = new ProjectWikiService({ workspace: root });
        const first = await wiki.init();
        const index = readFileSync(join(root, 'wiki', 'INDEX.md'), 'utf8');
        expect(first.created.length).toBeGreaterThan(0);
        expect(index).toContain('> 项目类型：Node.js (fixture)');
        expect(index).toContain('| 项目全貌与结构 |');
        expect(existsSync(join(root, 'wiki', 'overview', 'deployment.md'))).toBe(true);
        expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toContain(
            'Mazi runtime 内置维护',
        );

        writeFileSync(join(root, 'wiki', 'overview', 'architecture.md'), '# Custom\n', 'utf8');
        const second = await wiki.init();
        expect(second.created).toEqual([]);
        expect(readFileSync(join(root, 'wiki', 'overview', 'architecture.md'), 'utf8')).toBe(
            '# Custom\n',
        );
    });

    it('claim 漂移、纠正替代与遗忘会更新上下文可见性', async () => {
        const root = repo();
        const wiki = new ProjectWikiService({
            workspace: root,
            now: () => new Date(2026, 10, 8, 14, 0, 0),
        });
        await wiki.init();
        await wiki.addClaim({
            id: 'http-port',
            text: '服务监听 8787',
            evidence: [{ file: 'src/config.ts' }],
            claimOid: true,
        });
        await wiki.writeDoc(
            'INDEX.md',
            '# Fixture\n\n## 当前事实\n- 服务监听 8787\n- 服务监听 9000\n',
        );
        expect(wiki.promptFragment()).toContain('服务监听 8787');
        writeFileSync(join(root, 'src', 'config.ts'), 'export const port = 9000;\n', 'utf8');
        expect((await wiki.doctor()).stale).toBe(1);

        await wiki.correctClaim({
            oldId: 'http-port',
            newId: 'http-port-v2',
            text: '服务监听 9000',
            evidence: [{ file: 'src/config.ts' }],
            reason: '端口配置已修改',
            claimOid: true,
        });
        const corrected = readProjectWiki(root);
        expect(corrected?.claims.find((claim) => claim.id === 'http-port')).toMatchObject({
            status: 'retracted',
            retractionKind: 'corrected',
            supersededBy: 'http-port-v2',
        });
        expect(corrected?.claims.find((claim) => claim.id === 'http-port-v2')).toMatchObject({
            status: 'active',
            supersedes: 'http-port',
        });
        expect(wiki.promptFragment()).toContain('服务监听 9000');
        expect(wiki.promptFragment()).not.toContain('服务监听 8787');
        expect((await wiki.doctor()).stale).toBe(0);

        await wiki.forgetClaim({ id: 'http-port-v2', reason: '该部署方案已废弃' });
        expect(wiki.promptFragment()).not.toContain('服务监听 9000');
        expect(readProjectWiki(root)?.summary).toMatchObject({
            active: 0,
            retracted: 2,
            forgotten: 1,
        });
    });

    it('session-end 先出增量计划再记录活动，checkpoint 刷新最近更新', async () => {
        const root = repo();
        const wiki = new ProjectWikiService({
            workspace: root,
            now: () => new Date(2026, 10, 8, 14, 30, 0),
        });
        await wiki.init();
        await wiki.addClaim({
            id: 'http-port',
            text: '服务监听 8787',
            evidence: [{ file: 'src/config.ts' }],
        });
        writeFileSync(join(root, 'src', 'config.ts'), 'export const port = 8788;\n', 'utf8');
        git(root, 'add', 'src/config.ts');
        git(root, 'commit', '-q', '--no-verify', '-m', 'change port');

        const result = await wiki.sessionEnd({
            input: '修改服务端口',
            status: 'success',
            summary: '端口改为 8788',
        });
        expect(result.changed_files).toContain('src/config.ts');
        expect(result.claims.map((claim) => claim.id)).toContain('http-port');
        expect(result.activity.at).toBe('2026-11-08 14:30:00');
        expect(readFileSync(join(root, 'wiki', 'state', 'current.md'), 'utf8')).toContain(
            '修改服务端口',
        );
        expect(git(root, 'log', '-1', '--format=%s', '--', 'wiki')).toBe(
            'wiki(run): record session activity',
        );

        await wiki.verifyClaims({ ids: ['http-port'] });
        await wiki.checkpoint();
        expect(readFileSync(join(root, 'wiki', 'INDEX.md'), 'utf8')).toContain(
            'wiki(checkpoint): sync state & index',
        );
    });

    it('增量计划把已删除文件与可读取文件分开，并继续标记受影响 claim', async () => {
        const root = repo();
        const wiki = new ProjectWikiService({ workspace: root });
        await wiki.init();
        await wiki.addClaim({
            id: 'http-port',
            text: '服务监听 8787',
            evidence: [{ file: 'src/config.ts' }],
        });
        unlinkSync(join(root, 'src', 'config.ts'));
        git(root, 'add', '-u', 'src/config.ts');

        const plan = await wiki.updatePlan();

        expect(plan.changed_files).not.toContain('src/config.ts');
        expect(plan.deleted_files).toContain('src/config.ts');
        expect(plan.no_changes).toBe(false);
        expect(plan.claims.map((claim) => claim.id)).toContain('http-port');
        expect(plan.claims[0]?.evidence[0]?.status).toBe('missing');
    });

    it('staged doctor 用 index oid 拦截未同步的事实', async () => {
        const root = repo();
        const wiki = new ProjectWikiService({ workspace: root });
        await wiki.init();
        await wiki.addClaim({
            id: 'http-port',
            text: '服务监听 8787',
            evidence: [{ file: 'src/config.ts' }],
        });
        writeFileSync(join(root, 'src', 'config.ts'), 'export const port = 9000;\n', 'utf8');
        git(root, 'add', 'src/config.ts');
        const blocked = await wiki.doctorStaged();
        expect(blocked.ok).toBe(false);
        expect(blocked.findings[0]?.level).toBe('STALE');
        unlinkSync(join(root, 'src', 'config.ts'));
        git(root, 'add', '-u', 'src/config.ts');
        expect((await wiki.doctorStaged()).findings[0]?.level).toBe('MISSING');
    });
});
