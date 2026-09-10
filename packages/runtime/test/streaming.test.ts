import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessEvent, LLMProvider, LLMRequest, StreamCompletionEvent } from '@mazi/core';
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
        // 实时订阅：在 execute 之前注册，验证增量在执行过程中同步到达（非仅回放）
        const live: HarnessEvent[] = [];
        const unsubscribe = runtime.eventBus.subscribe(
            { types: ['llm.stream_event'] },
            { id: 'stream-test', handle: (event) => live.push(event) },
        );
        try {
            const created = await runtime.createGoalSession('打个招呼');
            await runtime.executeGoalTree(created.rootGoalId);
            const events = (runtime.eventBus as DefaultEventBus).replay(created.rootGoalId);
            expect(live).toHaveLength(5);
            expect(live.every((event) => event.type === 'llm.stream_event')).toBe(true);

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

            const started = events.filter((event) => event.type === 'step.started');
            const ended = events.filter((event) => event.type === 'step.ended');
            expect(ended.length).toBeGreaterThan(0);
            // Every step announces exactly one start before its ending events.
            expect(started).toHaveLength(ended.length);
            expect(started.every((event) => typeof event.stepId === 'string')).toBe(true);
            expect(started[0]?.stepId).toBe(ended[0]?.stepId);
        } finally {
            unsubscribe();
            await runtime.close();
        }
    });

    it('多步工具调用期间，goalSnapshot 已包含进行中的 task 与 step（供 /timeline 实时观测）', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-stream-'));
        dirs.push(dir);

        let runtimeRef: HarnessRuntime | undefined;
        let rootGoalId = '';
        let observed: string[] = [];

        const toolProvider: LLMProvider = {
            id: 'faux',
            name: 'faux',
            defaultModel: 'faux-model',
            models: [],
            async ask() {
                throw new ProviderError('unknown', 'ask unused');
            },
            async *askStream(request: LLMRequest): AsyncIterable<StreamCompletionEvent> {
                const hasTool = request.messages.some((message) => message.role === 'tool');
                if (!hasTool) {
                    yield { type: 'start', model: 'faux-model' };
                    yield { type: 'reasoning_delta', reasoning: 'calling tool' };
                    yield { type: 'tool_call_start', index: 0, callId: 'c1', name: 'probe.tool' };
                    yield { type: 'tool_call_delta', index: 0, argumentsDelta: '{}' };
                    yield { type: 'tool_call_stop', index: 0 };
                    yield { type: 'finish', finishReason: 'tool_calls' };
                } else {
                    yield { type: 'start', model: 'faux-model' };
                    yield { type: 'text_delta', text: 'done' };
                    yield { type: 'finish', finishReason: 'stop' };
                }
            },
        };

        const config: RuntimeConfig = {
            providers: [],
            tools: [
                {
                    name: 'probe.tool',
                    description: 'probe tool',
                    parameters: {},
                    minPermission: 'read-only',
                    sideEffects: [],
                    impl: async () => {
                        const snapshot = await runtimeRef!.goalSnapshot(rootGoalId);
                        observed = snapshot.goals.flatMap((goal) =>
                            goal.tasks.flatMap((task) =>
                                task.steps.map((step) => step.kind + ':' + step.status),
                            ),
                        );
                        return { ok: true, content: 'tool result' };
                    },
                },
            ],
            dbPath: ':memory:',
            eventDir: dir,
            goal: { allowedTools: ['probe.tool'], permissionCeiling: 'read-only' },
            contextWindow: 64000,
        };

        const runtime = new HarnessRuntime(config, { llmProviders: { default: toolProvider } });
        runtimeRef = runtime;
        try {
            const created = await runtime.createGoalSession('probe');
            rootGoalId = created.rootGoalId;
            await runtime.executeGoalTree(rootGoalId);
            // While the tool was still executing, the snapshot must already expose the
            // running task and the steps produced so far.
            expect(observed).toContain('thinking:ok');
            expect(observed).toContain('tool_call:running');
        } finally {
            await runtime.close();
        }
    });
});
