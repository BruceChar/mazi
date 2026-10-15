import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMProvider, LLMRequest, StreamCompletionEvent } from '@mazi/core';
import { afterEach, describe, expect, it } from 'vitest';

import type { RuntimeConfig, ToolConfig } from '../src/config.js';
import { HarnessRuntime } from '../src/harness/index.js';
import { WikiStore } from '../src/wiki/index.js';

const dirs: string[] = [];
const originalHome = process.env.MAZI_HOME;

function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
}

function systemText(request: LLMRequest): string {
    const system = request.system;
    if (typeof system === 'string') return system;
    return JSON.stringify(system ?? '');
}

/** 首轮给出 fs.write 调用，次轮给最终回答；记录每轮 system 提示。 */
function writingProvider(): { provider: LLMProvider; systems: string[] } {
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
            const hasToolResult = request.messages.some((message) => message.role === 'tool');
            if (!hasToolResult) {
                yield { type: 'tool_call_start', index: 0, callId: 'c1', name: 'fs.write' };
                yield {
                    type: 'tool_call_delta',
                    index: 0,
                    argumentsDelta: JSON.stringify({
                        path: 'src/a.ts',
                        content: 'export const a = 1;\n',
                    }),
                };
                yield { type: 'tool_call_stop', index: 0 };
                yield { type: 'finish', finishReason: 'tool_calls' };
                return;
            }
            yield { type: 'text_delta', text: '已完成' };
            yield { type: 'finish', finishReason: 'stop' };
        },
    };
    return { provider, systems };
}

afterEach(() => {
    if (originalHome === undefined) delete process.env.MAZI_HOME;
    else process.env.MAZI_HOME = originalHome;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('项目 wiki × HarnessRuntime（设计 §7/§8）', () => {
    it('新会话注入 wiki 快照；写工具改动落一条『时间 | 改动』', async () => {
        const home = tempDir('mazi-wikihome-');
        process.env.MAZI_HOME = home;
        const workspace = tempDir('mazi-wikiws-');
        mkdirSync(join(workspace, 'src'), { recursive: true });

        const store = new WikiStore({ home, workspace });
        await store.writeSnapshot('## 项目概览\nmazi 是 Agent Harness');

        const writeTool: ToolConfig = {
            name: 'fs.write',
            description: 'write a file',
            parameters: {},
            minPermission: 'draft',
            sideEffects: ['fs'],
            impl: async (args) => {
                const path = String(args.path ?? '');
                mkdirSync(join(workspace, 'src'), { recursive: true });
                writeFileSync(join(workspace, path), String(args.content ?? ''), 'utf8');
                return { ok: true, content: 'written' };
            },
        };
        const config: RuntimeConfig = {
            providers: [],
            tools: [writeTool],
            dbPath: ':memory:',
            eventDir: home,
            goal: { allowedTools: ['fs.write'], permissionCeiling: 'draft' },
            contextWindow: 64000,
        };
        const fake = writingProvider();
        const runtime = new HarnessRuntime(config, {
            llmProviders: { faux: fake.provider },
            workspaceRoot: workspace,
        });
        try {
            const created = await runtime.createGoalSession('给项目加个文件');
            const result = await runtime.executeGoalTree(created.rootGoalId);
            expect(result.ok).toBe(true);

            // 注入：会话开始即拿到项目状态快照
            expect(fake.systems[0]).toContain('## 项目 wiki');
            expect(fake.systems[0]).toContain('mazi 是 Agent Harness');

            // 记录：写工具改动 → 功能级条目（时间列 + 改动）
            const doc = store.read();
            const last = doc?.entries[doc.entries.length - 1];
            expect(doc?.entries.length).toBe(1);
            expect(last?.change).toContain('src');
            expect(last?.ts).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
            expect(readFileSync(join(workspace, 'src', 'a.ts'), 'utf8')).toContain('export const a');
            // 快照区不被日志写入破坏
            expect(doc?.snapshot).toContain('mazi 是 Agent Harness');
        } finally {
            await runtime.close();
        }
    });

    it('无写入的只读会话：仍注入并落地项目概览（首次会话不再空白）', async () => {
        const home = tempDir('mazi-wikihome-');
        process.env.MAZI_HOME = home;
        const workspace = tempDir('mazi-wikiws-');
        mkdirSync(join(workspace, 'packages', 'core'), { recursive: true });
        writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'whoami' }), 'utf8');
        const store = new WikiStore({ home, workspace });

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
                yield { type: 'text_delta', text: '只是回答问题' };
                yield { type: 'finish', finishReason: 'stop' };
            },
        };
        const config: RuntimeConfig = {
            providers: [],
            tools: [],
            dbPath: ':memory:',
            eventDir: home,
            goal: { allowedTools: [], permissionCeiling: 'read-only' },
            contextWindow: 64000,
        };
        const runtime = new HarnessRuntime(config, {
            llmProviders: { faux: provider },
            workspaceRoot: workspace,
        });
        try {
            const created = await runtime.createGoalSession('项目现在什么状态？');
            await runtime.executeGoalTree(created.rootGoalId);
            const doc = store.read();
            expect(doc?.entries).toHaveLength(0);
            // 首次会话即落地确定性项目概览（无模型、无写入也要有状态可读）
            expect(doc?.snapshot).toContain('## 项目概览');
            expect(doc?.snapshot).toContain('packages/core');
            // 且当轮 system prompt 已注入该快照
            expect(systems[0]).toContain('## 项目 wiki');
            expect(systems[0]).toContain('packages/core');
        } finally {
            await runtime.close();
        }
    });
});
