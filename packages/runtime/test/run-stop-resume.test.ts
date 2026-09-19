import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMProvider, StreamCompletionEvent } from '@mazi/core';
import { ProviderError } from '@mazi/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { HarnessRuntime } from '../src/harness/index.js';

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

/** 首次调用阻塞直到 abort（模拟长模型轮），之后返回最终回答。 */
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

describe('HarnessRuntime 停止/恢复（IR-D）', () => {
    it('stop 命中运行中的 run：模型轮中断，Task 置 aborted；resume 后继续到成功', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-stop-'));
        dirs.push(dir);
        const fake = interruptibleProvider();
        const runtime = new HarnessRuntime(configIn(dir), {
            llmProviders: { default: fake.provider },
        });
        try {
            const created = await runtime.createGoalSession('请执行长任务');
            const running = runtime.executeGoalTree(created.rootGoalId);
            await fake.started;
            expect(runtime.isGoalRunning(created.rootGoalId)).toBe(true);
            expect(runtime.stopGoalTree(created.rootGoalId)).toBe(true);

            const stopped = await running;
            expect(stopped.ok).toBe(false);
            expect(stopped.tasks[stopped.tasks.length - 1]?.reason).toBe('aborted');
            const tasks = await runtime.goalStore.listTasks(created.rootGoalId);
            expect(tasks[0]?.status).toBe('aborted');
            expect(runtime.isGoalRunning(created.rootGoalId)).toBe(false);
            // 空闲再次 stop 幂等（返回 false）。
            expect(runtime.stopGoalTree(created.rootGoalId)).toBe(false);

            const resumed = await runtime.resumeGoalTree(created.rootGoalId);
            expect(resumed.ok).toBe(true);
            expect(fake.calls()).toBe(2);
            const after = await runtime.goalStore.listTasks(created.rootGoalId);
            expect(after).toHaveLength(1);
            expect(after[0]?.status).toBe('succeeded');
        } finally {
            await runtime.close();
        }
    });
});
