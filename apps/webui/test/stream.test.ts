import { describe, expect, it } from 'vitest';
import {
    activeStream,
    applyStreamEvent,
    clearStreamsForTask,
    parseStreamDelta,
    type LiveStreamMap,
} from '../src/scripts/stream.ts';
import type { EventItem } from '../src/types.ts';

function streamEvent(
    options: {
        streamId?: string;
        attempt?: number;
        taskId?: string;
        payloadEvent?: Record<string, unknown>;
    } = {},
): EventItem {
    return {
        eventId: 'e-' + String(Math.random()),
        type: 'llm.stream_event',
        taskId: options.taskId ?? 't1',
        payload: {
            streamId: options.streamId ?? 's1',
            attempt: options.attempt ?? 1,
            event: options.payloadEvent ?? { type: 'text_delta', text: 'a' },
        },
    };
}

describe('webui 流式 reducer', () => {
    it('text_delta / reasoning_delta 分别累积', () => {
        let streams: LiveStreamMap = {};
        streams = applyStreamEvent(streams, streamEvent({ payloadEvent: { type: 'text_delta', text: '你' } }), 10);
        streams = applyStreamEvent(streams, streamEvent({ payloadEvent: { type: 'text_delta', text: '好' } }), 20);
        streams = applyStreamEvent(
            streams,
            streamEvent({ payloadEvent: { type: 'reasoning_delta', reasoning: '想' } }),
            30,
        );
        const stream = streams.s1!;
        expect(stream.text).toBe('你好');
        expect(stream.reasoning).toBe('想');
        expect(stream.taskId).toBe('t1');
        expect(stream.startedAt).toBe(10);
        expect(stream.updatedAt).toBe(30);
    });

    it('attempt 变化时重置该 stream 的增量', () => {
        let streams: LiveStreamMap = {};
        streams = applyStreamEvent(streams, streamEvent({ attempt: 1, payloadEvent: { type: 'text_delta', text: '旧' } }), 10);
        streams = applyStreamEvent(streams, streamEvent({ attempt: 2, payloadEvent: { type: 'text_delta', text: '新' } }), 20);
        expect(streams.s1!.text).toBe('新');
        expect(streams.s1!.attempt).toBe(2);
    });

    it('clearStreamsForTask 只清理对应 task', () => {
        let streams: LiveStreamMap = {};
        streams = applyStreamEvent(streams, streamEvent({ streamId: 's1', taskId: 't1' }), 10);
        streams = applyStreamEvent(streams, streamEvent({ streamId: 's2', taskId: 't2' }), 11);
        const next = clearStreamsForTask(streams, 't1');
        expect(Object.keys(next)).toEqual(['s2']);
    });

    it('activeStream 取 updatedAt 最大者', () => {
        let streams: LiveStreamMap = {};
        streams = applyStreamEvent(streams, streamEvent({ streamId: 's1' }), 10);
        streams = applyStreamEvent(streams, streamEvent({ streamId: 's2' }), 20);
        expect(activeStream(streams)?.streamId).toBe('s2');
        expect(activeStream({})).toBeNull();
    });

    it('非流式事件或结构非法时 parseStreamDelta 返回 null 且状态不变', () => {
        const streams: LiveStreamMap = {};
        expect(parseStreamDelta({ eventId: 'x', type: 'step.ended' })).toBeNull();
        expect(applyStreamEvent(streams, { eventId: 'y', type: 'step.ended' }, 5)).toBe(streams);
        expect(
            applyStreamEvent(streams, streamEvent({ payloadEvent: { type: 'usage' } }), 5),
        ).toBe(streams);
    });
});
