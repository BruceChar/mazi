import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMProvider, LLMRequest, StreamCompletionEvent } from '@mazi/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { HarnessRuntime } from '../src/harness/index.js';

const dirs: string[] = [];

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function textOf(request: LLMRequest): string {
    return [
        request.system ?? '',
        ...request.messages
            .flatMap((message) => message.content)
            .filter((block) => block.type === 'text')
            .map((block) => block.text),
    ].join('\n');
}

function runtimeConfig(dir: string): RuntimeConfig {
    return {
        providers: [],
        tools: [],
        dbPath: ':memory:',
        eventDir: dir,
        goal: { permissionCeiling: 'read-only' },
        contextWindow: 64000,
        wiki: { enabled: false },
    };
}

function triageProvider(plan: unknown): LLMProvider {
    return {
        id: 'fake',
        name: 'fake',
        defaultModel: 'fake-model',
        models: [],
        async ask() {
            throw new Error('ask unused');
        },
        async *askStream(request: LLMRequest): AsyncIterable<StreamCompletionEvent> {
            const isTriage = textOf(request).includes('intent triage layer');
            yield { type: 'start', model: 'fake-model' };
            yield {
                type: 'text_delta',
                text: isTriage ? JSON.stringify(plan) : '阶段完成。',
            };
            yield { type: 'finish', finishReason: 'stop' };
        },
    };
}

function workflowRoles(rootGoalId: string, dir: string): string[] {
    const raw = readFileSync(join(dir, `${rootGoalId}.jsonl`), 'utf8');
    return raw
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { type: string; payload?: { role?: string } })
        .filter((event) => event.type === 'workflow.node' && event.payload?.role !== undefined)
        .map((event) => event.payload?.role ?? '');
}

describe('统一编排：Router → Plan 是 workflow 节点', () => {
    it('随心聊不因会话类型跳过 Plan；Router 先于 Plan 决策', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-unified-'));
        dirs.push(dir);
        const runtime = new HarnessRuntime(runtimeConfig(dir), {
            llmProviders: {
                fake: triageProvider({
                    trace: {
                        classification: 'command',
                        taskType: 'research',
                        difficulty: 'complex',
                        needsPlan: true,
                        reason: ['多来源调研', '需要证据汇总'],
                    },
                    blocks: [{ route: 'confirmed', goals: ['调研并汇总资料'] }],
                }),
            },
            workspaceRoot: dir,
            taskPlanner: async () => [
                { key: 'only', title: '调研并汇总', dependsOn: [], requiredTools: [] },
            ],
        });
        try {
            const created = await runtime.createGoalSession('调研一下这个方向的现状', {
                parseIntent: true,
                taskPlanning: false,
                deferTriage: true,
            });
            const result = await runtime.executeGoalTree(created.rootGoalId);
            expect(result.ok).toBe(true);
            expect(result.tasks).toHaveLength(1);

            await new Promise((resolve) => setTimeout(resolve, 50));
            const raw = readFileSync(join(dir, `${created.rootGoalId}.jsonl`), 'utf8');
            const events = raw
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line) as { type: string; payload?: unknown });
            const decision = events.find((event) => event.type === 'superagent.decision');
            expect(decision?.payload).toMatchObject({
                route: 'workflow',
                needsPlan: true,
                difficulty: 'complex',
            });
            expect(events.some((event) => event.type === 'plan.created')).toBe(true);
            const roles = workflowRoles(created.rootGoalId, dir);
            expect(roles[0]).toBe('router');
            expect(roles.indexOf('plan')).toBeGreaterThan(0);
            expect(roles.indexOf('think')).toBeGreaterThan(roles.indexOf('plan'));
        } finally {
            await runtime.close();
        }
    });

    it('direct 路线在 Router 终止，不生成 Task', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-unified-direct-'));
        dirs.push(dir);
        const runtime = new HarnessRuntime(runtimeConfig(dir), {
            llmProviders: {
                fake: triageProvider({
                    trace: { classification: 'question', taskType: 'general', needsPlan: false },
                    blocks: [{ route: 'direct', goals: ['回答事实问题'], answer: '巴黎。' }],
                }),
            },
            workspaceRoot: dir,
        });
        try {
            const created = await runtime.createGoalSession('法国的首都是哪里？', {
                parseIntent: true,
                deferTriage: true,
            });
            const result = await runtime.executeGoalTree(created.rootGoalId);
            expect(result.ok).toBe(true);
            expect(result.tasks).toHaveLength(0);
            expect(result.finalAnswer).toBe('巴黎。');
            const roles = workflowRoles(created.rootGoalId, dir);
            expect(roles[0]).toBe('router');
            expect(roles.includes('plan')).toBe(false);
        } finally {
            await runtime.close();
        }
    });
});

describe('统一编排：异常终态也要验收', () => {
    it('没有可用 provider 时 Task 仍产出 acceptanceResult', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-unified-noprovider-'));
        dirs.push(dir);
        const runtime = new HarnessRuntime(runtimeConfig(dir), {
            workspaceRoot: dir,
        });
        try {
            const created = await runtime.createGoalSession('读取 README.md 并汇报', {
                parseIntent: true,
                deferTriage: true,
            });
            const result = await runtime.executeGoalTree(created.rootGoalId);
            expect(result.tasks).toHaveLength(1);
            expect(result.tasks[0]?.task.acceptanceResult?.total).toBe(1);
        } finally {
            await runtime.close();
        }
    });
});
