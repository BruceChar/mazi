import 'reflect-metadata';
import type { HarnessEvent } from '@mazi/core';
import { DefaultEventBus } from '@mazi/runtime';
import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import Logger from '../common/log.js';
import { ApiRuntimeService } from '../common/runtime.service.js';

const SSE_HEADERS = {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
} as const;

function sseFrame(event: HarnessEvent): string {
    return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * 回放过滤：llm.stream_event 是流式增量（传输态 Delta，AHF_CORE_PROVIDER §6），
 * 只用于实时渲染；正规内容以 step.ended 为准。回放（REST 与 SSE history）不返回它，
 * 避免订阅已完成 run 时把历史增量误当成 live，也避免海量增量帧拖慢连接。
 */
function replayable(events: HarnessEvent[]): HarnessEvent[] {
    return events.filter((event) => event.type !== 'llm.stream_event');
}

/**
 * GET /api/events/:id（docs v0.2 §10.4）：
 * - follow != 1 → 事件回放（只读 JSON 数组，手动 send，契约对齐旧实现）；
 * - follow = 1  → SSE：先回放已落盘事件，再订阅 HarnessRuntime 同一 DefaultEventBus
 *   （实例内订阅互通，运行中事件实时推送；15s 心跳；断连退订）。
 * 使用 @Res() 库模式：本处理器统一手动应答（回放 JSON / SSE 长连接）。
 */
@Controller('events')
export class EventsController {
    private readonly logger = new Logger('events');

    constructor(private readonly runtime: ApiRuntimeService) {}

    @Get(':id')
    replay(
        @Param('id') sessionId: string,
        @Query('follow') follow?: string,
        @Res() reply?: FastifyReply,
    ): void {
        const bus = this.runtime.harness().eventBus as DefaultEventBus;
        if (follow !== '1') {
            const events = replayable(bus.replay(sessionId));
            this.logger.log(`replay ${sessionId} → ${events.length} events`);
            void reply?.send(events);
            return;
        }
        if (!reply) {
            return;
        }
        const raw = reply.raw;
        reply.hijack();
        raw.writeHead(200, SSE_HEADERS);
        const history = replayable(bus.replay(sessionId));
        this.logger.log(`sse subscribe ${sessionId} (history=${history.length})`);
        for (const event of history) {
            raw.write(sseFrame(event));
        }
        const push = (event: HarnessEvent): void => {
            if (event.rootGoalId === sessionId) {
                raw.write(sseFrame(event));
            }
        };
        const unsubscribe = bus.subscribe({}, { id: `sse-${sessionId}`, handle: push });
        const ping = setInterval(() => raw.write(': ping\n\n'), 15000);
        raw.on('close', () => {
            clearInterval(ping);
            unsubscribe();
        });
    }
}
