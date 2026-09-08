import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
    LLMProvider,
    LLMRequest,
    LLMResponse,
    ProviderModel,
    StreamCompletionEvent,
} from '@mazi/core';
import { describe, expect, it } from 'vitest';
import type { RuntimeConfig } from './config.js';
import { HarnessRuntime } from './runtime.js';

class OfflineProvider implements LLMProvider {
    id = 'p';
    name = 'offline';
    defaultModel = 'm';
    models: ProviderModel[] = [];
    async ask(_request: LLMRequest): Promise<LLMResponse> {
        return { model: 'm', content: [{ type: 'text', text: '完成。' }], finishReason: 'stop' };
    }
    async *askStream(_request: LLMRequest): AsyncIterable<StreamCompletionEvent> {
        yield { type: 'text_delta', text: '完成。' };
        yield { type: 'finish', finishReason: 'stop' };
    }
}

function cfg(): RuntimeConfig {
    return {
        providers: [],
        tools: [],
        goal: { allowedTools: [], requiredTools: [], maxSteps: 2 },
        dbPath: ':memory:',
        eventDir: mkdtempSync(join(tmpdir(), 'mazi-goalpath-')),
        consoleEnabled: false,
    };
}

describe('HarnessRuntime Goal 路径（C3e，与旧 Session 路径共存）', () => {
    it('createGoalSession + executeGoalTree：intake→work→Task 执行成功', async () => {
        const rt = new HarnessRuntime(cfg(), { llmProviders: { p: new OfflineProvider() } });
        try {
            const created = await rt.createGoalSession('读取 README 并汇报');
            expect(created.goalId.length).toBeGreaterThan(0);
            const result = await rt.executeGoalTree(created.rootGoalId);
            expect(result.ok).toBe(true);
            expect(result.tasks).toHaveLength(1);
            expect(result.tasks[0]?.ok).toBe(true);
            expect(result.tasks[0]?.finalMessage).toContain('完成');
        } finally {
            await rt.close();
        }
    });
});
