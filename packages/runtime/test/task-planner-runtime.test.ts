import { mkdtempSync, rmSync } from 'node:fs';
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

describe('HarnessRuntime × Task Planner', () => {
    it('默认 LLM planner 将复杂 Goal 编译成有依赖的多个 Task', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-task-planner-'));
        dirs.push(dir);
        const calls: string[] = [];
        const provider: LLMProvider = {
            id: 'planner',
            name: 'planner',
            defaultModel: 'planner-model',
            models: [],
            async ask() {
                throw new Error('ask unused');
            },
            async *askStream(request: LLMRequest): AsyncIterable<StreamCompletionEvent> {
                const text = textOf(request);
                calls.push(text);
                yield { type: 'start', model: 'planner-model' };
                if (text.includes('Task Planner')) {
                    yield {
                        type: 'text_delta',
                        text: JSON.stringify({
                            tasks: [
                                {
                                    key: 'inspect',
                                    title: '检查项目结构与关键入口',
                                    dependsOn: [],
                                    requiredTools: ['rg', 'fs.read'],
                                },
                                {
                                    key: 'summarize',
                                    title: '归纳风险、验证结果与下一步',
                                    dependsOn: ['inspect'],
                                    requiredTools: [],
                                },
                            ],
                        }),
                    };
                } else {
                    yield { type: 'text_delta', text: '阶段完成' };
                }
                yield { type: 'finish', finishReason: 'stop' };
            },
        };
        const config: RuntimeConfig = {
            providers: [],
            tools: [],
            dbPath: ':memory:',
            eventDir: dir,
            goal: { permissionCeiling: 'read-only' },
            contextWindow: 64000,
            wiki: { enabled: false },
        };
        const runtime = new HarnessRuntime(config, {
            llmProviders: { planner: provider },
            workspaceRoot: dir,
            taskPlanning: true,
        });
        try {
            const created = await runtime.createGoalSession('分析项目并给出风险和下一步', {
                maxSteps: 6,
                maxCostUsd: 0.6,
            });
            const result = await runtime.executeGoalTree(created.rootGoalId);
            expect(result.ok).toBe(true);
            expect(result.tasks.map((item) => item.task.title)).toEqual([
                '检查项目结构与关键入口',
                '归纳风险、验证结果与下一步',
            ]);
            expect(result.tasks[1]?.task.dependsOn).toEqual([result.tasks[0]?.task.taskId]);
            expect(result.tasks.map((item) => item.task.budget?.maxSteps)).toEqual([3, 3]);
            expect(calls.filter((text) => text.includes('Task Planner'))).toHaveLength(1);
            const executionCalls = calls.filter((text) => !text.includes('Task Planner'));
            expect(executionCalls[0]).toContain('Task：检查项目结构与关键入口');
            expect(executionCalls[1]).toContain('Task：归纳风险、验证结果与下一步');
            expect(executionCalls[1]).toContain('已完成的前置 Task');
            expect(executionCalls[1]).toContain('阶段完成');
        } finally {
            await runtime.close();
        }
    });

    it('planner 抛错时在任何工具执行前回退单 Task', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-task-planner-fallback-'));
        dirs.push(dir);
        let plannerCalls = 0;
        const provider: LLMProvider = {
            id: 'planner',
            name: 'planner',
            defaultModel: 'planner-model',
            models: [],
            async ask() {
                throw new Error('ask unused');
            },
            async *askStream(): AsyncIterable<StreamCompletionEvent> {
                yield { type: 'start', model: 'planner-model' };
                yield { type: 'text_delta', text: '已完成。' };
                yield { type: 'finish', finishReason: 'stop' };
            },
        };
        const config: RuntimeConfig = {
            providers: [],
            tools: [],
            dbPath: ':memory:',
            eventDir: dir,
            goal: { permissionCeiling: 'read-only' },
            contextWindow: 64000,
            wiki: { enabled: false },
        };
        const runtime = new HarnessRuntime(config, {
            llmProviders: { planner: provider },
            workspaceRoot: dir,
            taskPlanner: async () => {
                plannerCalls += 1;
                throw new Error('invalid planner output');
            },
        });
        try {
            const created = await runtime.createGoalSession('完成一个简单目标');
            const result = await runtime.executeGoalTree(created.rootGoalId);
            expect(result.ok).toBe(true);
            expect(plannerCalls).toBe(1);
            expect(result.tasks).toHaveLength(1);
            expect(result.tasks[0]?.task.title).toBe('完成一个简单目标');
        } finally {
            await runtime.close();
        }
    });
});
