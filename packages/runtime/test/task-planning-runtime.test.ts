import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMProvider, LLMRequest, StreamCompletionEvent } from '@mazi/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import type { TaskPlanningInput } from '../src/gts/task-planner.js';
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

/** Provider that answers goal-parser triage requests with a fixed JSON block and其它轮次 with text. */
function triageProvider(plan: unknown, triageDelayMs = 30): LLMProvider {
    return {
        id: 'fake',
        name: 'fake',
        defaultModel: 'fake-model',
        models: [],
        async ask() {
            throw new Error('ask unused');
        },
        async *askStream(request: LLMRequest): AsyncIterable<StreamCompletionEvent> {
            const text = textOf(request);
            const isTriage = text.includes('intent triage layer');
            if (isTriage) await new Promise((resolve) => setTimeout(resolve, triageDelayMs));
            yield { type: 'start', model: 'fake-model' };
            yield {
                type: 'text_delta',
                text: isTriage ? JSON.stringify(plan) : '阶段完成。',
            };
            yield { type: 'finish', finishReason: 'stop' };
        },
    };
}

const SINGLE_TASK = [
    {
        key: 'execute',
        title: '执行方案 A',
        dependsOn: [],
        requiredTools: [],
    },
];

describe('HarnessRuntime × Task Planner 上下文与 triage 顺序', () => {
    it('把同一 Conversation 的历史传给 Task Planner', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-plan-history-'));
        dirs.push(dir);
        let plannerInput: TaskPlanningInput | undefined;
        const runtime = new HarnessRuntime(runtimeConfig(dir), {
            llmProviders: { fake: triageProvider({ blocks: [] }) },
            workspaceRoot: dir,
            taskPlanner: async (input) => {
                plannerInput = input;
                return SINGLE_TASK;
            },
        });
        try {
            const created = await runtime.createGoalSession('A', {
                taskPlanning: true,
                history: [
                    { role: 'user', text: '帮我修一下项目' },
                    { role: 'assistant', text: '方案 A：修复编译错误、提交基线、再实现 DFS' },
                    { role: 'user', text: 'A' },
                ],
            });
            await runtime.executeGoalTree(created.rootGoalId);
            expect(plannerInput?.history).toEqual([
                { role: 'user', text: '帮我修一下项目' },
                { role: 'assistant', text: '方案 A：修复编译错误、提交基线、再实现 DFS' },
                { role: 'user', text: 'A' },
            ]);
        } finally {
            await runtime.close();
        }
    });

    it('规划前等待 triage，并保留 triage 产出的机械检查条款', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-plan-triage-'));
        dirs.push(dir);
        let plannerInput: TaskPlanningInput | undefined;
        const runtime = new HarnessRuntime(runtimeConfig(dir), {
            llmProviders: {
                fake: triageProvider({
                    trace: { classification: 'command' },
                    blocks: [
                        {
                            route: 'confirmed',
                            goals: ['修复编译错误并实现 DFS'],
                            constraints: [
                                {
                                    text: '新建 src/dfs.rs 模块',
                                    check: { kind: 'file-exists', path: 'src/dfs.rs' },
                                },
                                '提交一次基线 commit，使后续改动可回滚',
                            ],
                        },
                    ],
                }),
            },
            workspaceRoot: dir,
            taskPlanner: async (input) => {
                plannerInput = input;
                return SINGLE_TASK;
            },
        });
        try {
            const created = await runtime.createGoalSession('A', {
                parseIntent: true,
                taskPlanning: true,
            });
            // 立即执行：triage 仍在进行中，runtime 必须先等它落库再规划。
            await runtime.executeGoalTree(created.rootGoalId);
            const goal = plannerInput?.goal;
            expect(goal?.negotiation?.route).toBe('confirmed');
            const conditions = goal?.contract.successConditions ?? [];
            // 两条基线 + triage 的 goals（1 条）+ constraints（2 条，其中一条带机械检查）。
            expect(conditions).toHaveLength(5);
            expect(
                conditions.some(
                    (condition) =>
                        condition.checkType === 'deterministic' &&
                        condition.check?.kind === 'file-exists',
                ),
            ).toBe(true);
            expect(
                conditions.some(
                    (condition) =>
                        condition.checkType === 'semantic' &&
                        (condition.description ?? '').includes('基线 commit'),
                ),
            ).toBe(true);
        } finally {
            await runtime.close();
        }
    });

    it('plan.created 事件带 Task 标题与依赖（可观测）', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-plan-event-'));
        dirs.push(dir);
        const runtime = new HarnessRuntime(runtimeConfig(dir), {
            llmProviders: { fake: triageProvider({ blocks: [] }) },
            workspaceRoot: dir,
            taskPlanner: async () => [
                { key: 'first', title: '第一步', dependsOn: [], requiredTools: [] },
                {
                    key: 'second',
                    title: '第二步',
                    dependsOn: ['first'],
                    requiredTools: [],
                },
            ],
        });
        try {
            const created = await runtime.createGoalSession('做两步', { taskPlanning: true });
            await runtime.executeGoalTree(created.rootGoalId);
            // 事件写入是异步链；等一拍再读 JSONL。
            await new Promise((resolve) => setTimeout(resolve, 50));
            const raw = readFileSync(join(dir, `${created.rootGoalId}.jsonl`), 'utf8');
            const events = raw
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line) as { type: string; payload?: unknown });
            const plan = events.find((event) => event.type === 'plan.created');
            const payload = plan?.payload as
                | { taskCount?: number; tasks?: Array<{ title: string; dependsOn: string[] }> }
                | undefined;
            expect(payload?.taskCount).toBe(2);
            expect(payload?.tasks?.map((task) => task.title)).toEqual(['第一步', '第二步']);
            expect(payload?.tasks?.[1]?.dependsOn).toHaveLength(1);
        } finally {
            await runtime.close();
        }
    });
});
