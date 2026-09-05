import 'reflect-metadata';
import type { RunResult } from '@mazi/harness-runtime';
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { SessionsService } from './sessions.service.js';

/** /api/sessions*：创建/列表/详情/执行/反馈（契约对齐 docs v0.2 §10.4；POST 均 200） */
@Controller('sessions')
export class SessionsController {
    constructor(private readonly sessions: SessionsService) {}

    @Post()
    @HttpCode(200)
    create(@Body() body: Record<string, unknown>): Promise<{ sessionId: string; state: string }> {
        return this.sessions.createSession(body);
    }

    @Get()
    list(@Query('limit') limit?: string) {
        return this.sessions.listSessions(Number.parseInt(limit ?? '50', 10));
    }

    @Post(':id/run')
    @HttpCode(200)
    execute(@Param('id') sessionId: string): Promise<RunResult> {
        return this.sessions.executeSession(sessionId);
    }

    @Get(':id')
    detail(@Param('id') sessionId: string) {
        return this.sessions.sessionDetail(sessionId);
    }

    @Get(':id/timeline')
    timeline(@Param('id') sessionId: string) {
        return this.sessions.sessionDetail(sessionId);
    }

    @Post(':id/feedback')
    @HttpCode(200)
    feedback(
        @Param('id') sessionId: string,
        @Body() body: Record<string, unknown>,
    ): Promise<{ ok: boolean }> {
        return this.sessions.recordFeedback(sessionId, body);
    }
}
