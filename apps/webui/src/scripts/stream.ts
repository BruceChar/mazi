import type { EventItem } from '../types.js';

/**
 * Pure streaming-response logic for the WebUI (docs/web/流式响应设计.md §5).
 * Reduces SSE llm.stream_event deltas into per-streamId live text;
 * free of Vue/DOM so it remains unit-testable.
 */

/** One in-flight stream (one requestRound = one streamId). */
export interface LiveStream {
    streamId: string;
    taskId: string;
    /** 1-based network attempt; a change means a retry and resets the deltas. */
    attempt: number;
    /** Accumulated reasoning_delta text. */
    reasoning: string;
    /** Accumulated text_delta text. */
    text: string;
    startedAt: number;
    updatedAt: number;
}

export type LiveStreamMap = Record<string, LiveStream>;

/** Parse an llm.stream_event into an accumulable delta; null when not a delta. */
export function parseStreamDelta(event: EventItem): {
    streamId: string;
    attempt: number;
    kind: 'text' | 'reasoning';
    delta: string;
} | null {
    if (event.type !== 'llm.stream_event') return null;
    const payload = event.payload as
        | {
              streamId?: unknown;
              attempt?: unknown;
              event?: { type?: unknown; text?: unknown; reasoning?: unknown };
          }
        | undefined;
    const streamId = payload?.streamId;
    if (typeof streamId !== 'string' || streamId.length === 0) return null;
    const attempt =
        typeof payload?.attempt === 'number' && Number.isFinite(payload.attempt)
            ? payload.attempt
            : 1;
    const streamEvent = payload?.event;
    if (streamEvent?.type === 'text_delta' && typeof streamEvent.text === 'string') {
        return { streamId, attempt, kind: 'text', delta: streamEvent.text };
    }
    if (streamEvent?.type === 'reasoning_delta' && typeof streamEvent.reasoning === 'string') {
        return { streamId, attempt, kind: 'reasoning', delta: streamEvent.reasoning };
    }
    return null;
}

/** Reduce one event; returns the same reference when nothing accumulates (avoids renders). */
export function applyStreamEvent(
    streams: LiveStreamMap,
    event: EventItem,
    now: number = Date.now(),
): LiveStreamMap {
    const parsed = parseStreamDelta(event);
    if (parsed === null) return streams;
    const existing = streams[parsed.streamId];
    const base: LiveStream =
        existing === undefined || existing.attempt !== parsed.attempt
            ? {
                  streamId: parsed.streamId,
                  taskId: taskIdOf(event),
                  attempt: parsed.attempt,
                  reasoning: '',
                  text: '',
                  startedAt: now,
                  updatedAt: now,
              }
            : existing;
    const next: LiveStream = {
        ...base,
        updatedAt: now,
        ...(parsed.kind === 'text'
            ? { text: base.text + parsed.delta }
            : { reasoning: base.reasoning + parsed.delta }),
    };
    return { ...streams, [parsed.streamId]: next };
}

/** Drop every stream of a task once its round ends and real steps take over. */
export function clearStreamsForTask(streams: LiveStreamMap, taskId: string): LiveStreamMap {
    if (!taskId) return {};
    const entries = Object.entries(streams).filter(([, stream]) => stream.taskId !== taskId);
    if (entries.length === Object.keys(streams).length) return streams;
    return Object.fromEntries(entries);
}

/** Newest active stream by updatedAt; null when there is none. */
export function activeStream(streams: LiveStreamMap): LiveStream | null {
    let best: LiveStream | null = null;
    for (const stream of Object.values(streams)) {
        if (best === null || stream.updatedAt > best.updatedAt) best = stream;
    }
    return best;
}

/** Owned taskId of an event (empty string when absent). */
export function taskIdOf(event: EventItem): string {
    return typeof event.taskId === 'string' ? event.taskId : '';
}
