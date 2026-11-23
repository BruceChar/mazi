import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMProvider, LLMRequest, StreamCompletionEvent } from '@mazi/core';
import { describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { HarnessRuntime } from '../src/harness/index.js';

function configIn(dir: string): RuntimeConfig {
    return {
        providers: [],
        tools: [],
        dbPath: ':memory:',
        eventDir: dir,
        goal: { permissionCeiling: 'read-only' },
        contextWindow: 64000,
    };
}

function textProvider(): LLMProvider {
    return {
        id: 'default',
        name: 'default',
        defaultModel: 'default',
        models: [],
        async ask() {
            throw new Error('ask unused');
        },
        async *askStream(_request: LLMRequest): AsyncIterable<StreamCompletionEvent> {
            yield { type: 'start', model: 'default' };
            yield { type: 'text_delta', text: '已完成。' };
            yield { type: 'finish', finishReason: 'stop' };
        },
    };
}

describe('loopMode 端到端', () => {
    it('dynamic 走节点引擎并标记结果', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-loop-'));
        const runtime = new HarnessRuntime(configIn(dir), {
            llmProviders: { default: textProvider() },
        });
        try {
            const { result } = await runtime.runGoalSession('做一件小事', {
                loopMode: 'dynamic',
                taskPlanning: false,
            });
            expect(result.ok).toBe(true);
            expect(result.loop?.mode).toBe('dynamic');
            expect(result.loop?.nodes).toBeGreaterThan(0);
        } finally {
            await runtime.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('缺省仍走 default，结果不带 loop 元信息', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-loop-'));
        const runtime = new HarnessRuntime(configIn(dir), {
            llmProviders: { default: textProvider() },
        });
        try {
            const { result } = await runtime.runGoalSession('做一件小事', { taskPlanning: false });
            expect(result.ok).toBe(true);
            expect(result.loop).toBeUndefined();
        } finally {
            await runtime.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
