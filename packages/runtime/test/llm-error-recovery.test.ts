import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMProvider, StreamCompletionEvent } from '@mazi/core';
import { ProviderError } from '@mazi/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { HarnessRuntime } from '../src/runtime.js';

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

interface FlakyProvider {
    provider: LLMProvider;
    modelsSeen: string[];
}

/** 首次用 bad-model 抛 invalid_request（模拟厂商 400），validModel 才成功。 */
function flakyProvider(validModel: string): FlakyProvider {
    const modelsSeen: string[] = [];
    return {
        modelsSeen,
        provider: {
            id: 'default',
            name: 'default',
            defaultModel: 'bad-model',
            models: [],
            async ask() {
                throw new Error('ask unused in recovery test');
            },
            async *askStream(request): AsyncIterable<StreamCompletionEvent> {
                const model = request.model ?? 'bad-model';
                modelsSeen.push(model);
                if (model !== validModel) {
                    throw new ProviderError(
                        'invalid_request',
                        'The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed ' +
                            model +
                            '.',
                    );
                }
                yield { type: 'start', model };
                yield { type: 'text_delta', text: 'ok' };
                yield { type: 'finish', finishReason: 'stop' };
            },
        },
    };
}

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('llm.error 事件 + 模型自愈重试', () => {
    it('模型被拒 → llm.error → 恢复回调换模 → provider.recovered 且任务成功', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-recover-'));
        dirs.push(dir);
        const flaky = flakyProvider('deepseek-flash');
        const runtime = new HarnessRuntime(configIn(dir), {
            llmProviders: { default: flaky.provider },
        });
        let recoveredCalls = 0;
        runtime.setModelRecovery(async (request) => {
            recoveredCalls += 1;
            expect(request.providerId).toBe('default');
            return { providerId: 'default', modelId: 'deepseek-flash' };
        });
        try {
            const created = await runtime.createGoalSession('你好');
            const result = await runtime.executeGoalTree(created.rootGoalId);
            expect(flaky.modelsSeen).toEqual(['bad-model', 'deepseek-flash']);
            expect(recoveredCalls).toBe(1);
            expect(result.ok).toBe(true);
            expect(result.tasks[0]?.reason).toBe('final-answer');

            const events = runtime.eventBus.replay(created.rootGoalId);
            const errorEvent = events.find((event) => event.type === 'llm.error');
            expect(errorEvent).toBeDefined();
            expect((errorEvent?.payload as { model?: string } | undefined)?.model).toBe('bad-model');
            expect(
                (errorEvent?.payload as { message?: string } | undefined)?.message,
            ).toMatch(/supported API model names/);
            expect(events.some((event) => event.type === 'provider.recovered')).toBe(true);
        } finally {
            await runtime.close();
        }
    });

    it('无恢复回调 → llm.error 后任务 driver-error（不换模重试）', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-recover-'));
        dirs.push(dir);
        const flaky = flakyProvider('deepseek-flash');
        const runtime = new HarnessRuntime(configIn(dir), {
            llmProviders: { default: flaky.provider },
        });
        try {
            const created = await runtime.createGoalSession('你好');
            const result = await runtime.executeGoalTree(created.rootGoalId);
            expect(result.ok).toBe(false);
            expect(result.tasks[0]?.reason).toBe('driver-error');
            expect(flaky.modelsSeen).toEqual(['bad-model']);
            const events = runtime.eventBus.replay(created.rootGoalId);
            expect(events.some((event) => event.type === 'llm.error')).toBe(true);
            expect(events.some((event) => event.type === 'provider.recovered')).toBe(false);
        } finally {
            await runtime.close();
        }
    });
});
