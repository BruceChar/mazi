import 'reflect-metadata';
import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { SessionsService } from './sessions.service.js';

/** /api/sessions*：Goal 会话（sessionId = rootGoalId）创建/执行/详情/反馈（POST 均 200） */
@Controller('sessions')
export class SessionsController {
    constructor(private readonly sessions: SessionsService) {}

    @Post()
    @HttpCode(200)
    create(@Body() body: Record<string, unknown>): Promise<{ sessionId: string; state: string }> {
        return this.sessions.createSession(body);
    }

    @Post(':id/run')
    @HttpCode(200)
    execute(@Param('id') sessionId: string) {
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
