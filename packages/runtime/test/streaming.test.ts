import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMProvider, StreamCompletionEvent } from '@mazi/core';
import { ProviderError } from '@mazi/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import type { DefaultEventBus } from '../src/observability/event-bus.js';
import { HarnessRuntime } from '../src/runtime.js';

/** faux provider：文本分两段流式产出，验证 llm.stream_event 逐增量透传。 */
function makeProvider(): LLMProvider {
    return {
        id: 'faux',
        name: 'faux',
        defaultModel: 'faux-model',
        models: [],
        async ask() {
            throw new ProviderError('unknown', 'ask unused in streaming test');
        },
        async *askStream(): AsyncIterable<StreamCompletionEvent> {
            yield { type: 'start', model: 'faux-model' };
            yield { type: 'text_delta', text: '你好' };
            yield { type: 'text_delta', text: '，世界' };
            yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } };
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

describe('HarnessRuntime 流式事件（llm.stream_event）', () => {
    it('执行会话时逐增量发出 llm.stream_event（带 taskId 与 streamId），step.ended 仍存在', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-stream-'));
        dirs.push(dir);
        const runtime = new HarnessRuntime(configIn(dir), {
            llmProviders: { default: makeProvider() },
        });
        try {
            const created = await runtime.createGoalSession('打个招呼');
            await runtime.executeGoalTree(created.rootGoalId);
            const events = (runtime.eventBus as DefaultEventBus).replay(created.rootGoalId);

            const streamEvents = events.filter((event) => event.type === 'llm.stream_event');
            expect(streamEvents).toHaveLength(5);
            expect(streamEvents.every((event) => typeof event.taskId === 'string')).toBe(true);
            expect(streamEvents.every((event) => typeof event.goalId === 'string')).toBe(true);

            const payloadOf = (event: (typeof streamEvents)[number]) =>
                event.payload as { streamId: string; attempt: number; event: StreamCompletionEvent };
            const streamId = payloadOf(streamEvents[0]!).streamId;
            expect(typeof streamId).toBe('string');
            expect(streamEvents.every((event) => payloadOf(event).streamId === streamId)).toBe(true);
            expect(streamEvents.every((event) => payloadOf(event).attempt === 1)).toBe(true);

            const deltas = streamEvents
                .map((event) => payloadOf(event).event)
                .filter((event) => event.type === 'text_delta');
            expect(deltas).toHaveLength(2);
            expect(deltas.map((event) => (event.type === 'text_delta' ? event.text : '')).join('')).toBe(
                '你好，世界',
            );

            expect(events.some((event) => event.type === 'step.ended')).toBe(true);
        } finally {
            await runtime.close();
        }
    });
});
