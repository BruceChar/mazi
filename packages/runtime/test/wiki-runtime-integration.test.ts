import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMProvider, LLMRequest, StreamCompletionEvent } from '@mazi/core';
import { afterEach, describe, expect, it } from 'vitest';

import { HarnessRuntime } from '../src/harness/index.js';
import { ProjectWikiService } from '../src/wiki/index.js';

const dirs: string[] = [];
const originalHome = process.env.MAZI_HOME;

function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
}

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRepo(prefix: string): string {
    const workspace = tempDir(prefix);
    git(workspace, 'init', '-q');
    git(workspace, 'config', 'user.email', 'project-wiki@example.com');
    git(workspace, 'config', 'user.name', 'Project Wiki Test');
    writeFileSync(join(workspace, 'README.md'), '# Project\n', 'utf8');
    git(workspace, 'add', '.');
    git(workspace, 'commit', '-q', '--no-verify', '-m', 'initial');
    return workspace;
}

function systemText(request: LLMRequest): string {
    return typeof request.system === 'string'
        ? request.system
        : JSON.stringify(request.system ?? '');
}

afterEach(() => {
    if (originalHome === undefined) delete process.env.MAZI_HOME;
    else process.env.MAZI_HOME = originalHome;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('runtime Project Wiki × HarnessRuntime', () => {
    it('项目会话无需挂载 Skill 即初始化 Project Wiki，并提供结构化 project_wiki 工具', async () => {
        const home = tempDir('mazi-wikihome-');
        process.env.MAZI_HOME = home;
        const workspace = makeRepo('mazi-project-wiki-init-');
        const requests: LLMRequest[] = [];
        const provider: LLMProvider = {
            id: 'faux',
            name: 'faux',
            defaultModel: 'faux-model',
            models: [],
            async ask() {
                throw new Error('ask unused');
            },
            async *askStream(request: LLMRequest): AsyncIterable<StreamCompletionEvent> {
                requests.push(request);
                yield { type: 'start', model: 'faux-model' };
                if (!request.messages.some((message) => message.role === 'tool')) {
                    yield { type: 'tool_call_start', index: 0, callId: 'wiki-doc', name: 'project_wiki' };
                    yield {
                        type: 'tool_call_delta',
                        index: 0,
                        argumentsDelta: JSON.stringify({
                            action: 'write_doc',
                            path: 'state/agent-note.md',
                            content: '# Agent note\n',
                        }),
                    };
                    yield { type: 'tool_call_stop', index: 0 };
                    yield { type: 'finish', finishReason: 'tool_calls' };
                    return;
                }
                yield { type: 'text_delta', text: '已经记录' };
                yield { type: 'finish', finishReason: 'stop' };
            },
        };
        const runtime = new HarnessRuntime(
            {
                providers: [],
                tools: [],
                dbPath: ':memory:',
                eventDir: home,
                goal: { allowedTools: ['project_wiki'], permissionCeiling: 'workspace-write' },
                contextWindow: 64000,
            },
            { llmProviders: { faux: provider }, workspaceRoot: workspace },
        );
        try {
            const created = await runtime.createGoalSession('你好');
            const result = await runtime.executeGoalTree(created.rootGoalId);
            expect(result.ok).toBe(true);
            expect(existsSync(join(workspace, 'wiki', 'claims.toml'))).toBe(true);
            expect(existsSync(join(workspace, 'AGENTS.md'))).toBe(true);
            expect(existsSync(join(workspace, 'wiki', 'state', 'agent-note.md'))).toBe(true);
            expect((requests[0]?.tools ?? []).map((tool) => tool.name)).toContain('project_wiki');
        } finally {
            await runtime.close();
        }
    });

    it('SessionStart 注入相关 Project Wiki 事实，已纠正或遗忘的旧事实不进入上下文', async () => {
        const home = tempDir('mazi-wikihome-');
        process.env.MAZI_HOME = home;
        const workspace = makeRepo('mazi-wiki-context-');
        writeFileSync(join(workspace, 'config.ts'), 'export const port = 9000;\n', 'utf8');
        git(workspace, 'add', 'config.ts');
        git(workspace, 'commit', '-q', '--no-verify', '-m', 'config');
        const wiki = new ProjectWikiService({ workspace });
        await wiki.init();
        await wiki.addClaim({
            id: 'port-v1',
            text: '服务监听旧端口 8787',
            evidence: [{ file: 'config.ts' }],
        });
        await wiki.correctClaim({
            oldId: 'port-v1',
            newId: 'port-v2',
            text: '服务监听端口 9000',
            evidence: [{ file: 'config.ts' }],
            reason: '端口配置已修正',
        });
        const systems: string[] = [];
        const provider: LLMProvider = {
            id: 'faux',
            name: 'faux',
            defaultModel: 'faux-model',
            models: [],
            async ask() {
                throw new Error('ask unused');
            },
            async *askStream(request: LLMRequest): AsyncIterable<StreamCompletionEvent> {
                systems.push(systemText(request));
                yield { type: 'start', model: 'faux-model' };
                yield { type: 'text_delta', text: '已读取' };
                yield { type: 'finish', finishReason: 'stop' };
            },
        };
        const runtime = new HarnessRuntime(
            {
                providers: [],
                tools: [],
                dbPath: ':memory:',
                eventDir: home,
                goal: { allowedTools: [], permissionCeiling: 'read-only' },
                contextWindow: 64000,
            },
            { llmProviders: { faux: provider }, workspaceRoot: workspace },
        );
        try {
            const created = await runtime.createGoalSession('项目端口是多少');
            await runtime.executeGoalTree(created.rootGoalId);
            expect(systems[0]).toContain('## Project Wiki');
            expect(systems[0]).toContain('服务监听端口 9000');
            expect(systems[0]).not.toContain('服务监听旧端口 8787');
            expect(systems[0]).not.toContain('## 项目 wiki（');
            expect(existsSync(join(home, 'wiki'))).toBe(false);
        } finally {
            await runtime.close();
        }
    });

    it('只读项目会话也会落地 runtime Project Wiki 骨架', async () => {
        const home = tempDir('mazi-wikihome-');
        process.env.MAZI_HOME = home;
        const workspace = makeRepo('mazi-wiki-ready-');
        const provider: LLMProvider = {
            id: 'faux',
            name: 'faux',
            defaultModel: 'faux-model',
            models: [],
            async ask() {
                throw new Error('ask unused');
            },
            async *askStream(): AsyncIterable<StreamCompletionEvent> {
                yield { type: 'start', model: 'faux-model' };
                yield { type: 'text_delta', text: '只回答' };
                yield { type: 'finish', finishReason: 'stop' };
            },
        };
        const runtime = new HarnessRuntime(
            {
                providers: [],
                tools: [],
                dbPath: ':memory:',
                eventDir: home,
                goal: { allowedTools: [], permissionCeiling: 'read-only' },
                contextWindow: 64000,
            },
            { llmProviders: { faux: provider }, workspaceRoot: workspace },
        );
        try {
            const created = await runtime.createGoalSession('项目现在什么状态？');
            await runtime.executeGoalTree(created.rootGoalId);
            expect(existsSync(join(workspace, 'wiki', 'INDEX.md'))).toBe(true);
            expect(existsSync(join(workspace, 'wiki', 'claims.toml'))).toBe(true);
            expect(existsSync(join(home, 'wiki'))).toBe(false);
        } finally {
            await runtime.close();
        }
    });
});
