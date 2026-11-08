import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectWikiService } from '@mazi/runtime';
import { ApiError } from '../src/common/api-error.js';
import { ProjectWikiMaintenanceService } from '../src/wiki/maintenance.service.js';

function runtimeFor(options: { failStart?: boolean } = {}) {
    let prompt = '';
    let goalOptions: Record<string, unknown> = {};
    let execute: () => Promise<unknown> = async () => ({
        ok: true,
        rejected: [],
        tasks: [{ finalMessage: '维护完成' }],
    });
    const createGoalSession = vi.fn(
        async (value: string, opts: Record<string, unknown>) => {
            prompt = value;
            goalOptions = opts;
            if (options.failStart) throw new Error('provider unavailable');
            return { rootGoalId: 'wiki-run', goalId: 'wiki-goal' };
        },
    );
    let snapshot: unknown = { goals: [] };
    const harness = {
        createGoalSession,
        executeGoalTree: vi.fn(async () => execute()),
        goalSnapshot: vi.fn(async () => snapshot),
        eventBus: { subscribe: () => () => undefined },
    };
    return {
        selectedWorkspaceRoot: undefined,
        setWorkspaceRoot: vi.fn(),
        skills: async () => ({ mounted: () => [] }),
        features: async () => ({
            resolve: () => ({ values: {}, trace: [], promptFragment: '' }),
        }),
        harness: () => harness,
        runBackgroundExclusive: async (operation: () => Promise<unknown>) => operation(),
        setPrompt: (value: string) => {
            prompt = value;
        },
        prompt: () => prompt,
        options: () => goalOptions,
        setExecute: (value: () => Promise<unknown>) => {
            execute = value;
        },
        setSnapshot: (value: unknown) => {
            snapshot = value;
        },
    };
}

function makeRepo(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'wiki@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Wiki Test'], { cwd: root });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'README.md'), '# Project\n', 'utf8');
    writeFileSync(join(root, 'src', 'config.ts'), 'export const port = 8787;\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-q', '--no-verify', '-m', 'initial'], { cwd: root });
    return root;
}

async function initializedRepo(prefix: string): Promise<{
    workspace: string;
    wiki: ProjectWikiService;
}> {
    const workspace = makeRepo(prefix);
    const wiki = new ProjectWikiService({ workspace });
    await wiki.init();
    await wiki.addClaim({
        id: 'http-port',
        text: '服务监听 8787',
        evidence: [{ file: 'src/config.ts' }],
    });
    return { workspace, wiki };
}

const dirs: string[] = [];

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('ProjectWikiMaintenanceService', () => {
    it('页面 init 用 runtime Project Wiki 骨架和隐藏后台 Goal 完成填库', async () => {
        const workspace = makeRepo('mazi-wiki-operation-');
        const runtime = runtimeFor();
        const service = new ProjectWikiMaintenanceService(runtime as never);
        const started = service.start('init', workspace);
        await vi.waitFor(() => {
            expect(service.get(started.id)).toMatchObject({
                state: 'succeeded',
                rootGoalId: 'wiki-run',
                summary: '维护完成',
            });
        });
        expect(runtime.harness().createGoalSession).toHaveBeenCalledTimes(1);
        expect(runtime.prompt()).toContain('骨架已经由 runtime 创建');
        expect(runtime.prompt()).not.toContain('wiki.py');
    });

    it('已初始化的 Project Wiki 再次 init 不启动 Agent', async () => {
        const { workspace } = await initializedRepo('mazi-wiki-ready-');
        const runtime = runtimeFor();
        const service = new ProjectWikiMaintenanceService(runtime as never);
        const started = service.start('init', workspace);
        await vi.waitFor(() => {
            expect(service.get(started.id)).toMatchObject({
                state: 'succeeded',
                summary: '项目 Wiki 已初始化，无需重复初始化',
            });
        });
        expect(runtime.harness().createGoalSession).not.toHaveBeenCalled();
    });

    it('update 无增量时直接返回，不启动 Agent', async () => {
        const { workspace } = await initializedRepo('mazi-wiki-nochange-');
        const runtime = runtimeFor();
        const service = new ProjectWikiMaintenanceService(runtime as never);
        const started = service.start('update', workspace);
        await vi.waitFor(() => {
            expect(service.get(started.id)).toMatchObject({
                state: 'succeeded',
                summary: '自上次 Wiki checkpoint 以来没有项目变化，无需更新',
            });
        });
        expect(runtime.harness().createGoalSession).not.toHaveBeenCalled();
    });

    it('记录后台失败原因，并对未知 operation 返回 404', async () => {
        const workspace = makeRepo('mazi-wiki-operation-');
        const runtime = runtimeFor({ failStart: true });
        const service = new ProjectWikiMaintenanceService(runtime as never);
        const started = service.start('init', workspace);
        await vi.waitFor(() => {
            expect(service.get(started.id)).toMatchObject({
                state: 'failed',
                error: 'provider unavailable',
            });
        });
        expect(() => service.get('missing')).toThrow(ApiError);
    });

    it('SessionEnd 无受影响事实时只记录活动，不启动 Agent', async () => {
        const { workspace } = await initializedRepo('mazi-wiki-sync-');
        const runtime = runtimeFor();
        const service = new ProjectWikiMaintenanceService(runtime as never);
        service.scheduleSessionSync({
            rootGoalId: 'session-1',
            workspace,
            projectId: 'project-1',
            input: '你好',
            ok: true,
            summary: '简单问候',
        });
        await vi.waitFor(() => {
            expect(service.currentSync(workspace)).toMatchObject({
                kind: 'sync',
                state: 'succeeded',
                sourceSessionId: 'session-1',
                summary: '会话活动已记录；未检测到项目文件变化',
            });
        });
        expect(runtime.harness().createGoalSession).not.toHaveBeenCalled();
    });

    it('SessionEnd 命中漂移时自动排队一次有界语义更新', async () => {
        const { workspace } = await initializedRepo('mazi-wiki-sync-update-');
        writeFileSync(join(workspace, 'src', 'config.ts'), 'export const port = 9000;\n', 'utf8');
        writeFileSync(join(workspace, 'README.md'), '# Project changed\n', 'utf8');
        const runtime = runtimeFor();
        const service = new ProjectWikiMaintenanceService(runtime as never);
        service.scheduleSessionSync({
            rootGoalId: 'session-2',
            workspace,
            projectId: 'project-1',
            input: '改端口',
            ok: true,
            summary: '端口改为 9000',
        });
        await vi.waitFor(() => {
            expect(service.current(workspace)).toMatchObject({
                kind: 'update',
                state: 'succeeded',
                sourceSessionId: 'session-2',
            });
        });
        expect(runtime.options().maxSteps).toBeGreaterThanOrEqual(12);
        expect(runtime.options().allowedTools).toContain('project_wiki');
        expect(runtime.prompt()).toContain('claim_verify');
    });

    it('只读探索即使没有 diff 也沉淀知识，且排除用户数据目录', async () => {
        const { workspace } = await initializedRepo('mazi-wiki-research-');
        mkdirSync(join(workspace, 'data'), { recursive: true });
        writeFileSync(join(workspace, 'data', 'profile.json'), '{"secret":true}\n', 'utf8');
        const runtime = runtimeFor();
        runtime.setSnapshot({
            goals: [
                {
                    tasks: [
                        {
                            steps: [
                                {
                                    kind: 'invocation',
                                    toolName: 'cat',
                                    toolArguments: { path: 'README.md' },
                                },
                                {
                                    kind: 'invocation',
                                    toolName: 'cat',
                                    toolArguments: { path: 'data/profile.json' },
                                },
                                {
                                    kind: 'invocation',
                                    toolName: 'bat',
                                    toolArguments: { path: 'src/config.ts' },
                                },
                                {
                                    kind: 'invocation',
                                    toolName: 'rg',
                                    toolArguments: { path: 'README.md' },
                                },
                                {
                                    kind: 'invocation',
                                    toolName: 'eza',
                                    toolArguments: { path: '.' },
                                },
                                {
                                    kind: 'invocation',
                                    toolName: 'fd',
                                    toolArguments: { pattern: 'deploy' },
                                },
                            ],
                        },
                    ],
                },
            ],
        });
        const service = new ProjectWikiMaintenanceService(runtime as never);
        service.scheduleSessionSync({
            rootGoalId: 'session-research',
            workspace,
            projectId: 'project-1',
            input: '项目怎么部署',
            ok: false,
            summary: '项目通过本地进程启动，服务和工具分别读取项目配置与入口文件。',
        });
        await vi.waitFor(() => {
            expect(service.current(workspace)).toMatchObject({
                kind: 'update',
                state: 'succeeded',
                sourceSessionId: 'session-research',
            });
        });
        expect(runtime.prompt()).toContain('README.md');
        expect(runtime.prompt()).toContain('src/config.ts');
        expect(runtime.prompt()).not.toContain('data/profile.json');
    });

    it('非关键工具错误但 runtime 已 checkpoint 时仍标记成功', async () => {
        const workspace = makeRepo('mazi-wiki-checkpoint-');
        const runtime = runtimeFor();
        runtime.setExecute(async () => {
            const wiki = new ProjectWikiService({ workspace });
            await wiki.writeDoc('overview/deployment.md', '# Deployment\n\n- Local runtime\n');
            await wiki.checkpoint();
            return {
                ok: false,
                rejected: [],
                tasks: [{ finalMessage: '初始化完成' }],
            };
        });
        const service = new ProjectWikiMaintenanceService(runtime as never);
        const started = service.start('init', workspace);
        await vi.waitFor(() => {
            expect(service.get(started.id)).toMatchObject({
                state: 'succeeded',
                summary: '初始化完成',
            });
        });
        expect(service.get(started.id).trace?.map((entry) => entry.type)).toContain(
            'agent.completed-with-warnings',
        );
    });
});
