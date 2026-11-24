import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMProvider, StreamCompletionEvent } from '@mazi/core';
import { ProviderError } from '@mazi/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../../src/config.js';
import { createRuntimeEvalExecutor, runEvalTask, type EvalTask } from '../../src/eval/index.js';
import { HarnessRuntime } from '../../src/harness/index.js';

function configIn(dir: string): RuntimeConfig {
    return {
        providers: [],
        tools: [],
        dbPath: ':memory:',
        eventDir: dir,
        goal: { allowedTools: [], permissionCeiling: 'read-only' },
        contextWindow: 64000,
    };
}

const task: EvalTask = {
    id: 'runtime-workflow',
    title: '真实 Runtime 执行',
    difficulty: 'simple',
    category: 'runtime',
    risk: 'read-only',
    input: '请总结当前系统状态',
    allowedTools: [],
    acceptance: [],
};

/** 首次调用阻塞直到 abort，之后返回最终回答：用于真实中断/恢复。 */
function interruptibleProvider(): {
    provider: LLMProvider;
    started: Promise<void>;
    calls: () => number;
} {
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
        markStarted = resolve;
    });
    let calls = 0;
    const waitForAbort = (signal?: AbortSignal): Promise<void> =>
        new Promise<void>((resolve) => {
            if (signal?.aborted === true) {
                resolve();
                return;
            }
            signal?.addEventListener('abort', () => resolve(), { once: true });
        });
    const provider: LLMProvider = {
        id: 'default',
        name: 'default',
        defaultModel: 'default',
        models: [],
        async ask() {
            throw new Error('ask unused');
        },
        async *askStream(request): AsyncIterable<StreamCompletionEvent> {
            calls += 1;
            if (calls === 1) {
                markStarted();
                await waitForAbort(request.signal);
                throw new ProviderError('aborted', 'caller aborted');
            }
            yield { type: 'start', model: request.model ?? 'default' };
            yield { type: 'text_delta', text: '恢复后的最终回答' };
            yield { type: 'finish', finishReason: 'stop' };
        },
    };
    return { provider, started, calls: () => calls };
}

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Benchmark 走真实 Runtime（WorkflowRunner + 生命周期）', () => {
    it('任务经 WorkflowRunner 执行，报告带 turn/step 证据', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-eval-runtime-'));
        dirs.push(dir);
        let rootGoalId = '';
        const provider: LLMProvider = {
            id: 'default',
            name: 'default',
            defaultModel: 'default',
            models: [],
            async ask() {
                throw new Error('ask unused');
            },
            async *askStream(request): AsyncIterable<StreamCompletionEvent> {
                yield { type: 'start', model: request.model ?? 'default' };
                yield { type: 'text_delta', text: '系统状态正常' };
                yield { type: 'finish', finishReason: 'stop' };
            },
        };
        const runtime = new HarnessRuntime(configIn(dir), {
            llmProviders: { default: provider },
        });
        try {
            const result = await runEvalTask(
                task,
                createRuntimeEvalExecutor(runtime, {
                    onSessionStarted: (_taskId, id) => {
                        rootGoalId = id;
                    },
                }),
            );
            expect(result.success).toBe(true);
            expect(result.observation.steps).toBeGreaterThan(0);
            const evidence = result.observation.runtime;
            expect(evidence?.rootGoalId).toBe(rootGoalId);
            expect(evidence?.turns).toBe(1);
            expect(evidence?.resumed).toBe(false);
            expect(evidence?.eventCounts['turn.started']).toBe(1);
            expect(evidence?.eventCounts['turn.ended']).toBe(1);
            expect(evidence?.eventCounts['step.started'] ?? 0).toBeGreaterThan(0);
            expect(evidence?.eventCounts['goal.ended']).toBe(1);

            // WorkflowRunner 的 think 节点在真实 Goal 树上落成 deliberation Step。
            const snapshot = await runtime.goalSnapshot(rootGoalId);
            const steps = snapshot.goals.flatMap((goal) => goal.tasks).flatMap((item) => item.steps);
            expect(steps.some((step) => step.kind === 'deliberation')).toBe(true);
        } finally {
            await runtime.close();
        }
    });

    it('中断走真实 AbortSignal；恢复从断点继续且运行证据标记 resumed', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-eval-runtime-'));
        dirs.push(dir);
        const fake = interruptibleProvider();
        const runtime = new HarnessRuntime(configIn(dir), {
            llmProviders: { default: fake.provider },
        });
        let rootGoalId = '';
        const executor = createRuntimeEvalExecutor(runtime, {
            onSessionStarted: (_taskId, id) => {
                rootGoalId = id;
            },
        });
        try {
            const running = runEvalTask(task, executor);
            await fake.started;
            expect(runtime.isGoalRunning(rootGoalId)).toBe(true);
            expect(runtime.stopGoalTree(rootGoalId)).toBe(true);

            const stopped = await running;
            expect(stopped.observation.aborted).toBe(true);
            expect(stopped.success).toBe(false);
            expect(stopped.observation.runtime?.rootGoalId).toBe(rootGoalId);
            expect(stopped.observation.runtime?.eventCounts['run.aborted']).toBe(1);
            expect(runtime.isGoalRunning(rootGoalId)).toBe(false);

            const resumed = await runEvalTask(task, executor, {
                resumeGoalId: rootGoalId,
            });
            expect(resumed.success).toBe(true);
            expect(resumed.observation.runtime?.rootGoalId).toBe(rootGoalId);
            expect(resumed.observation.runtime?.resumed).toBe(true);
            expect(fake.calls()).toBe(2);
        } finally {
            await runtime.close();
        }
    });
});
