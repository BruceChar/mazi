import type { EventItem } from '../types.js';

/**
 * WebUI 流式响应纯逻辑（docs/web/流式响应设计.md §5）。
 * 把 SSE 的 llm.stream_event 增量归约成按 streamId 分组的活动文本；
 * 不依赖 Vue/DOM，便于单测。
 */

/** 一路正在生成的活动流（一次 requestRound = 一个 streamId）。 */
export interface LiveStream {
    streamId: string;
    taskId: string;
    /** 1-based 网络尝试序号；变化即代表重试，需重置增量 */
    attempt: number;
    /** reasoning_delta 累积 */
    reasoning: string;
    /** text_delta 累积 */
    text: string;
    startedAt: number;
    updatedAt: number;
}

export type LiveStreamMap = Record<string, LiveStream>;

/** 解析 llm.stream_event 为可累积的增量；非流式或结构非法返回 null。 */
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

/** 归约一条 llm.stream_event；无可累积增量时原样返回同一引用（避免无谓渲染）。 */
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

/** 清除某个 task 下的全部活动流（该 task 的轮次已结束，正式 Step 即将渲染）。 */
export function clearStreamsForTask(streams: LiveStreamMap, taskId: string): LiveStreamMap {
    if (!taskId) return {};
    const entries = Object.entries(streams).filter(([, stream]) => stream.taskId !== taskId);
    if (entries.length === Object.keys(streams).length) return streams;
    return Object.fromEntries(entries);
}

/** 当前最新活动流（updatedAt 最大者）；无活动流返回 null。 */
export function activeStream(streams: LiveStreamMap): LiveStream | null {
    let best: LiveStream | null = null;
    for (const stream of Object.values(streams)) {
        if (best === null || stream.updatedAt > best.updatedAt) best = stream;
    }
    return best;
}

/** 事件归属的 taskId（缺失时为空串）。 */
export function taskIdOf(event: EventItem): string {
    return typeof event.taskId === 'string' ? event.taskId : '';
}
