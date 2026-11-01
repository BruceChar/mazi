import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMProvider, LLMRequest, StreamCompletionEvent } from '@mazi/core';
import { describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { HarnessRuntime } from '../src/harness/runtime.js';
import { CORE_PROMPT } from '../src/prompts/index.js';

function provider(prompts: string[]): LLMProvider {
    return {
        id: 'default',
        name: 'scripted',
        defaultModel: 'scripted',
        models: [],
        async ask(request: LLMRequest) {
            prompts.push(request.system ?? '');
            return {
                model: 'scripted',
                content: [{ type: 'text', text: '完成' }],
                finishReason: 'stop',
            };
        },
        async *askStream(request: LLMRequest): AsyncIterable<StreamCompletionEvent> {
            prompts.push(request.system ?? '');
            yield { type: 'text_delta', text: '完成' };
            yield { type: 'finish', finishReason: 'stop' };
        },
    };
}

function config(): RuntimeConfig {
    return {
        providers: [],
        tools: [],
        dbPath: ':memory:',
        eventDir: mkdtempSync(join(tmpdir(), 'mazi-superagent-')),
        goal: { allowedTools: [] },
        contextWindow: 32_000,
    };
}

describe('SuperAgent runtime integration', () => {
    it('injects different PromptPacks and audits the orchestration decision', async () => {
        const prompts: string[] = [];
        const llm = provider(prompts);
        const runtime = new HarnessRuntime(config(), { llmProviders: { default: llm } });
        try {
            const coding = await runtime.runGoalSession('实现一个新接口', {
                llmProviders: { default: llm },
                promptPackIds: ['coding'],
                maxSteps: 2,
            });
            const general = await runtime.runGoalSession('你好', {
                llmProviders: { default: llm },
                maxSteps: 2,
            });
            expect(prompts[0]).toContain(CORE_PROMPT);
            expect(prompts[0]).toContain('软件工程执行规范');
            expect(prompts[1]).toContain(CORE_PROMPT);
            expect(prompts[1]).not.toContain('软件工程执行规范');

            const events = runtime.eventBus.replay(coding.rootGoalId);
            expect(
                events.filter((event) => event.type === 'superagent.decision'),
            ).toHaveLength(1);
            expect(
                events.filter((event) => event.type === 'prompt.pack.selected'),
            ).toHaveLength(1);
            expect(runtime.eventBus.replay(general.rootGoalId).some((event) => event.type === 'prompt.pack.selected')).toBe(true);
        } finally {
            await runtime.close();
        }
    });
});
