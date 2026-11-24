/**
 * 持久化策略（R5 §3.1）：只决定"落盘时丢弃/裁剪什么"，不影响 emit 与内存订阅。
 * 内存事件始终完整，供 SSE/UI 实时渲染；持久化副本只用于审计索引，故丢弃流式碎片、
 * 剥离 step 大文本。纯函数，便于单测。
 */
import type { HarnessEvent } from '@mazi/core';

/** 不落盘的事件类型：provider 逐 token 流式回调，最终文本已落在 step 结果里。 */
const SKIP_PERSIST_TYPES = new Set(['llm.stream_event']);

/** 落盘时需要剥离大文本的 step 事件类型。 */
const SLIM_STEP_TYPES = new Set(['step.started', 'step.ended']);

/** step payload 中不持久化的大文本字段（全文回复/输出）。 */
const STRIP_FIELDS = new Set(['content', 'thinking', 'answer', 'output', 'result']);

/** 该事件是否需要落盘；false 表示持久化层跳过（内存分发照常）。 */
export function shouldPersist(event: HarnessEvent): boolean {
    return !SKIP_PERSIST_TYPES.has(event.type);
}

/**
 * 返回用于落盘的裁剪副本：step 事件剥离大文本字段，保留结构化元数据与 usage。
 * 不修改原事件；非 step 事件原样返回。
 */
export function slimForStore(event: HarnessEvent): HarnessEvent {
    if (!SLIM_STEP_TYPES.has(event.type)) return event;
    const { payload } = event;
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return event;
    const source = payload as Record<string, unknown>;
    const slim: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
        if (!STRIP_FIELDS.has(key)) slim[key] = value;
    }
    return { ...event, payload: slim };
}
