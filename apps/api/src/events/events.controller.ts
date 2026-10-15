import 'reflect-metadata';
import type { HarnessEvent } from '@mazi/core';
import type { DefaultEventBus } from '@mazi/runtime';
import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import Logger from '../common/log.js';
import { ApiRuntimeService } from '../common/runtime.service.js';
import { replayEvents, streamEvents } from './sse.js';

/**
 * GET /api/events/:id（docs v0.2 §10.4；主会话链路）：
 * - follow != 1 → 事件回放（只读 JSON 数组）；
 * - follow = 1  → SSE：先回放已落盘事件，再订阅 HarnessRuntime 同一 DefaultEventBus。
 * AB 实验室走独立运行时的事件流：GET /api/experiments/:id/arms/:label/events。
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
            const events: HarnessEvent[] = replayEvents(bus, sessionId);
            this.logger.log(`replay ${sessionId} → ${events.length} events`);
            void reply?.send(events);
            return;
        }
        if (!reply) {
            return;
        }
        this.logger.log(
            `sse subscribe ${sessionId} (history=${replayEvents(bus, sessionId).length})`,
        );
        streamEvents(bus, sessionId, reply);
    }
}
