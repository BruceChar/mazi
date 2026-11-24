/**
 * 持久化策略（R5 §3.1）：只决定"落盘时丢弃/裁剪什么"，不影响 emit 与内存订阅。
 * 内存事件始终完整，供 SSE/UI 实时渲染；持久化副本只用于审计索引。纯函数，便于单测。
 *
 * 实际最终内容由 step.ended 承载；逐 token 的 llm.stream_event 碎片不落盘。
 */
import type { HarnessEvent } from '@mazi/core';

/** step.ended 单个文本字段落盘截断上限（字符）。 */
export const CONTENT_CAP = 4000;

/** 不落盘的事件类型：provider 逐 token 流式回调，最终文本已落在 step 结果里。 */
const SKIP_PERSIST_TYPES = new Set(['llm.stream_event']);

/** step.started 落盘时丢弃的大文本字段（实际内容由 step.ended 承载，避免重复存全文）。 */
const STARTED_DROP_FIELDS = new Set(['content', 'thinking', 'answer', 'output', 'result']);

/** 该事件是否需要落盘；false 表示持久化层跳过（内存分发照常）。 */
export function shouldPersist(event: HarnessEvent): boolean {
    return !SKIP_PERSIST_TYPES.has(event.type);
}

/** 读取 payload 为普通对象；非对象/数组返回 undefined。 */
function readRecord(payload: unknown): Record<string, unknown> | undefined {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
    return payload as Record<string, unknown>;
}

/** 超长字符串截断封顶，其余值原样返回。 */
function capText(value: unknown): unknown {
    if (typeof value !== 'string' || value.length <= CONTENT_CAP) return value;
    return `${value.slice(0, CONTENT_CAP)}…（内容截断，上限 ${CONTENT_CAP} 字）`;
}

/**
 * 返回用于落盘的裁剪副本，不修改原事件：
 * - step.started：只存元数据，丢弃重复全文；
 * - step.ended：保留实际内容与元数据，超长文本截断封顶；
 * - 其余事件原样返回。
 */
export function slimForStore(event: HarnessEvent): HarnessEvent {
    const record = readRecord(event.payload);
    if (record === undefined) return event;

    if (event.type === 'step.started') {
        const slim: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(record)) {
            if (!STARTED_DROP_FIELDS.has(key)) slim[key] = value;
        }
        return { ...event, payload: slim };
    }

    if (event.type === 'step.ended') {
        const slim: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(record)) {
            slim[key] = capText(value);
        }
        return { ...event, payload: slim };
    }

    return event;
}
