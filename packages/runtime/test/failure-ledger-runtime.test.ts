import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMProvider, StreamCompletionEvent } from '@mazi/core';
import { ProviderError } from '@mazi/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { HarnessRuntime } from '../src/harness/index.js';

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function configIn(dir: string): RuntimeConfig {
    return {
        providers: [],
        tools: [],
        dbPath: join(dir, 'mazi.db'),
        eventDir: dir,
        goal: { allowedTools: [], permissionCeiling: 'read-only' },
        contextWindow: 64000,
    };
}

function failingProvider(): LLMProvider {
    return {
        id: 'default',
        name: 'default',
        defaultModel: 'default',
        models: [],
        async ask() {
            throw new ProviderError('unknown', 'ask unused');
        },
        async *askStream(): AsyncIterable<StreamCompletionEvent> {
            throw new ProviderError('unknown', 'boom');
        },
    };
}

/** 首次调用阻塞直到 abort（模拟长模型轮）。 */
function interruptibleProvider(): { provider: LLMProvider; started: Promise<void> } {
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
        markStarted = resolve;
    });
    const provider: LLMProvider = {
        id: 'default',
        name: 'default',
        defaultModel: 'default',
        models: [],
        async ask() {
            throw new ProviderError('unknown', 'ask unused');
        },
        async *askStream(request): AsyncIterable<StreamCompletionEvent> {
            markStarted();
            await new Promise<void>((resolve) => {
                if (request.signal?.aborted === true) return resolve();
                request.signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            throw new ProviderError('aborted', 'caller aborted');
        },
    };
    return { provider, started };
}

describe('failure-ledger 运行时写入点', () => {
    it('Task 终态失败（driver-error）落账，含 session/task 与模型', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-ledger-rt-'));
        dirs.push(dir);
        const runtime = new HarnessRuntime(configIn(dir), {
            llmProviders: { default: failingProvider() },
        });
        try {
            const { rootGoalId } = await runtime.runGoalSession('会失败的会话');
            const failures = await runtime.listFailures();
            expect(failures).toHaveLength(1);
            expect(failures[0]).toMatchObject({
                sessionId: rootGoalId,
                kind: 'driver-error',
                summary: 'boom',
            });
            expect(failures[0]?.taskId).toBeTruthy();
        } finally {
            await runtime.close();
        }
    });

    it('aborted（协作式停止）不记失败', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-ledger-abort-'));
        dirs.push(dir);
        const fake = interruptibleProvider();
        const runtime = new HarnessRuntime(configIn(dir), {
            llmProviders: { default: fake.provider },
        });
        try {
            const created = await runtime.createGoalSession('长任务');
            const running = runtime.executeGoalTree(created.rootGoalId);
            await fake.started;
            runtime.stopGoalTree(created.rootGoalId);
            const stopped = await running;
            expect(stopped.tasks[0]?.reason).toBe('aborted');
            expect(await runtime.listFailures()).toEqual([]);
        } finally {
            await runtime.close();
        }
    });
});
