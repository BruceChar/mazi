import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMMessage, LLMProvider, LLMRequest, StreamCompletionEvent } from '@mazi/core';
import { ProviderError } from '@mazi/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { HarnessRuntime } from '../src/runtime.js';

function messageText(message: LLMMessage): string {
    if (message.role === 'user' || message.role === 'assistant') {
        return message.content
            .map((block) => (block.type === 'text' ? block.text : ''))
            .join('');
    }
    return '';
}

function capturingProvider(seen: string[][]): LLMProvider {
    return {
        id: 'faux',
        name: 'faux',
        defaultModel: 'faux-model',
        models: [],
        async ask() {
            throw new ProviderError('unknown', 'ask unused');
        },
        async *askStream(request: LLMRequest): AsyncIterable<StreamCompletionEvent> {
            seen.push(request.messages.map(messageText));
            yield { type: 'start', model: 'faux-model' };
            yield { type: 'text_delta', text: 'answer' };
            yield { type: 'finish', finishReason: 'stop' };
        },
    };
}

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

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe('Conversation 共享上下文', () => {
    it('createGoalSession 携带 history → 首次请求以历史消息开头，且计入 runtime 历史段', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-conv-'));
        dirs.push(dir);
        const seen: string[][] = [];
        const runtime = new HarnessRuntime(configIn(dir), {
            llmProviders: { default: capturingProvider(seen) },
        });
        try {
            const created = await runtime.createGoalSession('second question', {
                history: [
                    { role: 'user', text: 'first question' },
                    { role: 'assistant', text: 'first answer' },
                ],
            });
            await runtime.executeGoalTree(created.rootGoalId);

            expect(seen[0]).toEqual(['first question', 'first answer', 'second question']);

            const snapshot = await runtime.goalSnapshot(created.rootGoalId);
            const usage = snapshot.goals
                .flatMap((goal) => goal.tasks)
                .flatMap((task) => task.steps)
                .find((step) => step.usage !== undefined)?.usage;
            expect(usage?.runtime?.historyUserTokens).toBeGreaterThan(0);
            expect(usage?.runtime?.historyAssistantTokens).toBeGreaterThan(0);
            // diff 只含本步新增输入，不含历史
            expect(usage?.runtime?.diffContent).toContain('second question');
            expect(usage?.runtime?.diffContent).not.toContain('first question');
        } finally {
            await runtime.close();
        }
    });

    it('reasoningLevel 透传到 LLMRequest.extra.reasoningEffort', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-conv-'));
        dirs.push(dir);
        const extras: Array<Record<string, unknown> | undefined> = [];
        const provider: LLMProvider = {
            id: 'faux',
            name: 'faux',
            defaultModel: 'faux-model',
            models: [],
            async ask() {
                throw new ProviderError('unknown', 'ask unused');
            },
            async *askStream(request: LLMRequest): AsyncIterable<StreamCompletionEvent> {
                extras.push(request.extra);
                yield { type: 'start', model: 'faux-model' };
                yield { type: 'text_delta', text: 'ok' };
                yield { type: 'finish', finishReason: 'stop' };
            },
        };
        const runtime = new HarnessRuntime(configIn(dir), {
            llmProviders: { default: provider },
        });
        try {
            const created = await runtime.createGoalSession('q', { reasoningLevel: 'high' });
            await runtime.executeGoalTree(created.rootGoalId);
            expect(extras[0]?.reasoningEffort).toBe('high');
        } finally {
            await runtime.close();
        }
    });

    it('无 history → messages 只有本轮输入', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-conv-'));
        dirs.push(dir);
        const seen: string[][] = [];
        const runtime = new HarnessRuntime(configIn(dir), {
            llmProviders: { default: capturingProvider(seen) },
        });
        try {
            const created = await runtime.createGoalSession('only question');
            await runtime.executeGoalTree(created.rootGoalId);
            expect(seen[0]).toEqual(['only question']);
        } finally {
            await runtime.close();
        }
    });
});
