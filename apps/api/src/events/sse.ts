/**
 * 事件流（回放 + SSE）共享实现 —— 主会话与 AB 实验室共用同一份语义
 * （docs/web/流式响应设计.md §2）。两条链路只是**总线不同**：
 * 主会话用 chat runtime 的总线，AB 实验室用独立实验运行时（独立 events 目录）的总线。
 */

import type { HarnessEvent } from '@mazi/core';
import type { DefaultEventBus } from '@mazi/runtime';
import type { FastifyReply } from 'fastify';

const SSE_HEADERS = {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
} as const;

function sseFrame(event: HarnessEvent): string {
    return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * 回放过滤：llm.stream_event 是流式增量（传输态 Delta），只用于实时渲染；
 * 回放（REST 与 SSE history）不返回它，避免把历史增量误当成 live、也避免海量帧拖慢连接。
 */
export function replayable(events: HarnessEvent[]): HarnessEvent[] {
    return events.filter((event) => event.type !== 'llm.stream_event');
}

/** 只读回放某 rootGoal 的全部事件（不含流式增量）。 */
export function replayEvents(bus: DefaultEventBus, rootGoalId: string): HarnessEvent[] {
    return replayable(bus.replay(rootGoalId));
}

/** follow=1：先回放已落盘事件，再订阅总线实时推送（15s 心跳；断连退订）。 */
export function streamEvents(bus: DefaultEventBus, rootGoalId: string, reply: FastifyReply): void {
    const raw = reply.raw;
    reply.hijack();
    raw.writeHead(200, SSE_HEADERS);
    for (const event of replayEvents(bus, rootGoalId)) {
        raw.write(sseFrame(event));
    }
    const push = (event: HarnessEvent): void => {
        if (event.rootGoalId === rootGoalId) raw.write(sseFrame(event));
    };
    const unsubscribe = bus.subscribe({}, { id: `sse-${rootGoalId}`, handle: push });
    const ping = setInterval(() => raw.write(': ping\n\n'), 15000);
    raw.on('close', () => {
        clearInterval(ping);
        unsubscribe();
    });
}
