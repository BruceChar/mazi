import type { StreamCompletionEvent, TokenUsage } from '@mazi/core';
import { ProviderError } from '@mazi/core';
import { describe, expect, it } from 'vitest';
import { aggregateStream } from '../../src/provider/aggregate.js';

function streamOf(events: StreamCompletionEvent[]): AsyncIterable<StreamCompletionEvent> {
    return (async function* () {
        for (const event of events) {
            yield event;
        }
    })();
}

function timers(): { startedAt: number; firstEventAt?: number; endedAt?: number } {
    return { startedAt: Date.now() };
}

const usage: TokenUsage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

describe('StreamAggregator（AHF_RUNTIME_PROVIDER §3）', () => {
    it('text_delta 按到达顺序拼接为单个 TextBlock', async () => {
        const round = await aggregateStream(
            streamOf([
                { type: 'text_delta', text: 'he' },
                { type: 'text_delta', text: 'llo' },
                { type: 'finish', finishReason: 'stop' },
            ]),
            timers(),
        );
        expect(round.response.content).toEqual([{ type: 'text', text: 'hello' }]);
        expect(round.response.finishReason).toBe('stop');
        expect(round.totalMs).toBeGreaterThanOrEqual(0);
    });

    it('reasoning 与 text 交错时按到达顺序保序', async () => {
        const round = await aggregateStream(
            streamOf([
                { type: 'reasoning_delta', reasoning: '先思考' },
                { type: 'text_delta', text: '再回答' },
                { type: 'finish', finishReason: 'stop' },
            ]),
            timers(),
        );
        expect(round.response.content).toEqual([
            { type: 'reasoning', text: '先思考' },
            { type: 'text', text: '再回答' },
        ]);
    });

    it('tool call 按 index 建槽、delta 拼接、stop 封槽解析', async () => {
        const round = await aggregateStream(
            streamOf([
                { type: 'tool_call_start', index: 0, callId: 'c1', name: 'get_time' },
                { type: 'tool_call_delta', index: 0, argumentsDelta: '{"tz":' },
                { type: 'tool_call_delta', index: 0, argumentsDelta: '"UTC"}' },
                { type: 'tool_call_stop', index: 0 },
                { type: 'finish', finishReason: 'tool_calls' },
            ]),
            timers(),
        );
        expect(round.response.finishReason).toBe('tool_calls');
        expect(round.response.toolCalls).toEqual([
            { callId: 'c1', name: 'get_time', arguments: { tz: 'UTC' } },
        ]);
    });

    it('usage 事件汇入 response.usage；start 携带 model', async () => {
        const round = await aggregateStream(
            streamOf([
                { type: 'start', model: 'faux-model', responseId: 'r1' },
                { type: 'text_delta', text: 'hi' },
                { type: 'usage', usage },
                { type: 'finish', finishReason: 'stop' },
            ]),
            timers(),
        );
        expect(round.response.model).toBe('faux-model');
        expect(round.response.id).toBe('r1');
        expect(round.response.usage).toEqual(usage);
    });

    it('空 content 且无 toolCalls → TextBlock("") 占位', async () => {
        const round = await aggregateStream(
            streamOf([{ type: 'finish', finishReason: 'stop' }]),
            timers(),
        );
        expect(round.response.content).toEqual([{ type: 'text', text: '' }]);
    });

    it('单个畸形 tool call 丢弃，其余照常（§3.3）', async () => {
        const round = await aggregateStream(
            streamOf([
                { type: 'tool_call_start', index: 0, callId: 'bad', name: 'boom' },
                { type: 'tool_call_delta', index: 0, argumentsDelta: 'not-json' },
                { type: 'tool_call_stop', index: 0 },
                { type: 'tool_call_start', index: 1, callId: 'ok', name: 'fine' },
                { type: 'tool_call_delta', index: 1, argumentsDelta: '{"a":1}' },
                { type: 'tool_call_stop', index: 1 },
                { type: 'finish', finishReason: 'tool_calls' },
            ]),
            timers(),
        );
        expect(round.response.toolCalls).toEqual([
            { callId: 'ok', name: 'fine', arguments: { a: 1 } },
        ]);
    });

    it('全部畸形且 finishReason=tool_calls → 抛 ProviderError(unknown)（§3.3）', async () => {
        await expect(
            aggregateStream(
                streamOf([
                    { type: 'tool_call_start', index: 0, callId: 'bad', name: 'boom' },
                    { type: 'tool_call_delta', index: 0, argumentsDelta: 'nope' },
                    { type: 'tool_call_stop', index: 0 },
                    { type: 'finish', finishReason: 'tool_calls' },
                ]),
                timers(),
            ),
        ).rejects.toSatisfy(
            (error: unknown) => error instanceof ProviderError && error.code === 'unknown',
        );
    });
});
