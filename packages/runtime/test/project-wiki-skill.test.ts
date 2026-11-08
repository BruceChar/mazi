import { execFileSync, spawnSync } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { asSkillRoot, SkillRegistry } from '../src/capabilities/index.js';

const skillDir = fileURLToPath(new URL('../builtin-skills/project-wiki/', import.meta.url));
const script = join(skillDir, 'scripts', 'wiki.py');
const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    roots.push(dir);
    return dir;
}

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRepo(): string {
    const root = tempDir('mazi-project-wiki-');
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'project-wiki@example.com');
    git(root, 'config', 'user.name', 'Project Wiki Test');
    return root;
}

function wiki(root: string, ...args: string[]): string {
    return execFileSync('python3', [script, ...args], { cwd: root, encoding: 'utf8' });
}

function wikiResult(root: string, ...args: string[]) {
    return spawnSync('python3', [script, ...args], { cwd: root, encoding: 'utf8' });
}

function fixtureRepo(): string {
    const root = makeRepo();
    writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({
            name: 'fixture',
            scripts: { check: 'echo ok' },
            workspaces: ['packages/*'],
        }),
        'utf8',
    );
    mkdirSync(join(root, 'packages', 'core'), { recursive: true });
    writeFileSync(
        join(root, 'packages', 'core', 'package.json'),
        JSON.stringify({ name: '@fixture/core' }),
        'utf8',
    );
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'auth service.ts'), 'export const token = 1;\n', 'utf8');
    return root;
}

describe('project-wiki 内置 Skill', () => {
    it('可通过 SkillRegistry 发现并加载随包脚本', () => {
        const registry = SkillRegistry.open({ roots: [asSkillRoot(dirname(skillDir), 'builtin')] });
        expect(registry.errors()).toEqual([]);
        const skill = registry.get('project-wiki');
        expect(skill?.scope).toBe('builtin');
        expect(skill?.document.resources).toContain(join('scripts', 'wiki.py'));
        expect(skill?.document.body).not.toContain('</skill>');
    });

    it('init 幂等生成根与模块 wiki，所有嵌套 root 可被 doctor --all 校验', () => {
        const root = fixtureRepo();
        const canonicalRoot = realpathSync(root);
        wiki(root, 'init', '--per-module');
        wiki(root, 'init', '--per-module');

        expect(readFileSync(join(root, 'AGENTS.md'), 'utf8').match(/<!-- WIKI:START -->/g)).toHaveLength(
            1,
        );
        expect(existsSync(join(root, 'wiki', 'state', 'lessons', 'README.md'))).toBe(true);
        expect(existsSync(join(root, 'packages', 'core', 'wiki', 'claims.toml'))).toBe(true);
        expect(existsSync(join(root, 'packages', 'core', 'AGENTS.md'))).toBe(true);
        const report = wiki(root, 'doctor', '--all');
        expect(report).toContain(`--- root: ${join(canonicalRoot, 'packages', 'core')}`);
        expect(report).not.toContain('INDEX 链接不可达');
    });

    it('init 使用领域中立的通用模板，overview 文档共享同一信息结构', () => {
        const root = fixtureRepo();
        wiki(root, 'init');
        const index = readFileSync(join(root, 'wiki', 'INDEX.md'), 'utf8');
        expect(index).toContain('> 项目类型：Node.js (fixture)');
        expect(index).toContain('| 项目全貌与结构 |');
        expect(index).toContain('| 工作方式与约定 |');
        expect(index).toContain('| 环境、资源与交付 |');
        expect(index).not.toContain('> 技术栈：');
        expect(index).not.toContain('| 怎么写代码 |');

        for (const name of ['architecture.md', 'conventions.md', 'deployment.md']) {
            const text = readFileSync(join(root, 'wiki', 'overview', name), 'utf8');
            expect(text).toMatch(/^## 目标与边界$/m);
            expect(text).toMatch(/^## 当前内容$/m);
            expect(text).toMatch(/^## 约束与例外$/m);
            expect(text).toMatch(/^## 来源与证据$/m);
        }
        const commands = readFileSync(join(root, 'wiki', 'overview', 'commands.md'), 'utf8');
        expect(commands).toContain('# 常用流程与命令');
        expect(commands).toContain('## 工作流程');
        expect(commands).toContain('## 可执行入口');
    });

    it('无技术清单的目录仍可初始化成通用项目 wiki', () => {
        const root = makeRepo();
        mkdirSync(join(root, 'research'), { recursive: true });
        writeFileSync(join(root, 'research', 'notes.md'), '# Notes\n', 'utf8');
        wiki(root, 'init');
        const index = readFileSync(join(root, 'wiki', 'INDEX.md'), 'utf8');
        expect(index).toContain('通用项目（未检测到技术清单）');
        expect(readFileSync(join(root, 'wiki', 'overview', 'commands.md'), 'utf8')).toContain(
            '没有命令的项目可以只写步骤',
        );
    });

    it('record 将普通会话确定性写入当前状态并限定活动行数', () => {
        const root = fixtureRepo();
        wiki(root, 'init');
        for (let index = 0; index < 3; index += 1) {
            wiki(
                root,
                'record',
                '--input',
                `第 ${index + 1} 次聊天`,
                '--status',
                'success',
                '--summary',
                '完成一次项目会话',
            );
        }
        const current = readFileSync(join(root, 'wiki', 'state', 'current.md'), 'utf8');
        expect(current).toContain('## 会话活动');
        expect(current).toContain('<!-- activity:start -->');
        expect(current).toContain('第 3 次聊天');
        expect(current.match(/第 \d 次聊天/g)).toHaveLength(3);
        expect(git(root, 'log', '-1', '--format=%s', '--', 'wiki')).toBe(
            'wiki(run): record session activity',
        );
        wiki(root, 'checkpoint');
        expect(readFileSync(join(root, 'wiki', 'INDEX.md'), 'utf8')).toMatch(
            /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/,
        );
    });

    it('session-end 先产出增量清单再记录活动，批量 verify 可一次处理全部 oid', () => {
        const root = fixtureRepo();
        git(root, 'add', '-A');
        git(root, 'commit', '-q', '--no-verify', '-m', 'initial project');
        wiki(root, 'init');
        wiki(
            root,
            'claim',
            'add',
            '--id',
            'auth-token',
            '--text',
            'token defaults to one',
            '--ev',
            'src/auth service.ts',
        );
        writeFileSync(join(root, 'src', 'auth service.ts'), 'export const token = 2;\n', 'utf8');
        git(root, 'add', 'src/auth service.ts');
        git(root, 'commit', '-q', '--no-verify', '-m', 'change token');

        const result = JSON.parse(
            wiki(
                root,
                'session-end',
                '--input',
                '修改 token',
                '--status',
                'success',
                '--summary',
                '已完成',
                '--json',
            ),
        ) as {
            changed_files: string[];
            claims: Array<{ id: string }>;
            needs_semantic_update: boolean;
            activity: { at: string; input: string };
        };
        expect(result.changed_files).toContain('src/auth service.ts');
        expect(result.claims.map((claim) => claim.id)).toContain('auth-token');
        expect(result.needs_semantic_update).toBe(true);
        expect(result.activity.at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
        expect(readFileSync(join(root, 'wiki', 'state', 'current.md'), 'utf8')).toContain(
            '修改 token',
        );
        expect(git(root, 'log', '-1', '--format=%s', '--', 'wiki')).toBe(
            'wiki(run): record session activity',
        );

        // 活动提交位于项目提交之后，但不能被误当成增量 diff 的新 checkpoint。
        const plan = JSON.parse(wiki(root, 'update', '--plan', '--json')) as {
            changed_files: string[];
            claims: Array<{ id: string }>;
        };
        expect(plan.changed_files).toContain('src/auth service.ts');
        expect(plan.claims.map((claim) => claim.id)).toContain('auth-token');

        wiki(root, 'claim', 'verify', '--ids', 'auth-token');
        const verified = JSON.parse(wiki(root, 'update', '--plan', '--json')) as {
            no_changes: boolean;
            claims: unknown[];
            needs_semantic_update: boolean;
        };
        expect(verified.no_changes).toBe(true);
        expect(verified.claims).toEqual([]);
        expect(verified.needs_semantic_update).toBe(false);
    });

    it('claim 自动提交只动 wiki，保留用户 staged WIP，并按 index oid 拦截门禁', () => {
        const root = fixtureRepo();
        wiki(root, 'init');
        writeFileSync(join(root, 'staged-wip.txt'), 'user work\n', 'utf8');
        git(root, 'add', 'staged-wip.txt');

        wiki(
            root,
            'claim',
            'add',
            '--id',
            'auth-token',
            '--text',
            'token defaults to one',
            '--ev',
            'src/auth service.ts',
        );
        expect(git(root, 'diff', '--cached', '--name-only')).toContain('staged-wip.txt');
        expect(readFileSync(join(root, 'wiki', 'claims.toml'), 'utf8')).toContain(
            '[claims.auth-token]',
        );

        writeFileSync(join(root, 'src', 'auth service.ts'), 'export const token = 2;\n', 'utf8');
        git(root, 'add', 'src/auth service.ts');
        const blocked = wikiResult(root, 'doctor', '--staged');
        expect(blocked.status).toBe(1);
        expect(blocked.stderr).toContain('提交门禁');

        wiki(
            root,
            'claim',
            'update',
            '--id',
            'auth-token',
            '--text',
            'token defaults to two',
            '--ev',
            'src/auth service.ts',
        );
        expect(wikiResult(root, 'doctor', '--staged').status).toBe(0);

        writeFileSync(join(root, 'src', 'auth service.ts'), 'export const token = 3;\n', 'utf8');
        expect(wikiResult(root, 'doctor', '--staged').status).toBe(0);
        expect(wikiResult(root, 'doctor', '--claim', 'auth-token').stdout).toContain('STALE');
    });

    it('evidence 缺失时 verify 失败且不写 verified 时间', () => {
        const root = fixtureRepo();
        wiki(root, 'init');
        wiki(
            root,
            'claim',
            'add',
            '--id',
            'auth-token',
            '--text',
            'token defaults to one',
            '--ev',
            'src/auth service.ts',
        );
        const claimsPath = join(root, 'wiki', 'claims.toml');
        const before = readFileSync(claimsPath, 'utf8');
        unlinkSync(join(root, 'src', 'auth service.ts'));

        const result = wikiResult(root, 'claim', 'verify', '--id', 'auth-token');
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('evidence 缺失');
        expect(readFileSync(claimsPath, 'utf8')).toBe(before);
    });

    it('模块 cwd 写入嵌套 claims，根 checkpoint 会校验所有嵌套 root', () => {
        const root = fixtureRepo();
        const moduleRoot = join(root, 'packages', 'core');
        mkdirSync(join(moduleRoot, 'src'), { recursive: true });
        writeFileSync(join(moduleRoot, 'src', 'core.ts'), 'export const core = 1;\n', 'utf8');
        wiki(root, 'init', '--per-module');

        wiki(
            moduleRoot,
            'claim',
            'add',
            '--id',
            'core-default',
            '--text',
            'core defaults to one',
            '--ev',
            'src/core.ts',
        );
        expect(git(root, 'ls-files', 'packages/core/wiki/claims.toml')).toBe(
            'packages/core/wiki/claims.toml',
        );

        writeFileSync(join(moduleRoot, 'src', 'core.ts'), 'export const core = 2;\n', 'utf8');
        const checkpoint = wikiResult(root, 'checkpoint');
        expect(checkpoint.status).toBe(1);
        expect(checkpoint.stderr).toContain('存在未修复漂移');
    });

    it('pre-commit 安装到已有 Husky hooks 源文件', () => {
        const root = fixtureRepo();
        mkdirSync(join(root, '.husky', '_'), { recursive: true });
        writeFileSync(join(root, '.husky', 'pre-commit'), '# existing checks\n', 'utf8');
        writeFileSync(join(root, '.husky', '_', 'pre-commit'), '# husky shim\n', 'utf8');
        git(root, 'config', 'core.hooksPath', '.husky/_');

        wiki(root, 'init');
        const hook = readFileSync(join(root, '.husky', 'pre-commit'), 'utf8');
        expect(hook).toContain('# existing checks');
        expect(hook).toContain('doctor --staged');
        expect(readFileSync(join(root, '.husky', '_', 'pre-commit'), 'utf8')).toBe(
            '# husky shim\n',
        );
    });
});
