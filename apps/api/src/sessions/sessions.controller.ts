import 'reflect-metadata';
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { SessionsService } from './sessions.service.js';

/** /api/sessions*：Goal 会话（sessionId = rootGoalId）创建/执行/详情/反馈（POST 统一 200，见 PostStatus200Interceptor） */
@Controller('sessions')
export class SessionsController {
    constructor(private readonly sessions: SessionsService) {}

    @Post()
    create(@Body() body: Record<string, unknown>): Promise<{ sessionId: string; state: string }> {
        return this.sessions.createSession(body);
    }

    @Post(':id/run')
    execute(@Param('id') sessionId: string) {
        return this.sessions.executeSession(sessionId);
    }

    @Post(':id/stop')
    stop(@Param('id') sessionId: string) {
        return this.sessions.stopSession(sessionId);
    }

    @Post(':id/resume')
    resume(@Param('id') sessionId: string, @Body() body: Record<string, unknown>) {
        return this.sessions.resumeSession(sessionId, body);
    }

    @Get(':id')
    detail(@Param('id') sessionId: string) {
        return this.sessions.sessionDetail(sessionId);
    }

    @Get(':id/timeline')
    timeline(@Param('id') sessionId: string) {
        return this.sessions.sessionDetail(sessionId);
    }

    @Get(':id/tasks/:taskId/thinking')
    thinking(@Param('id') sessionId: string, @Param('taskId') taskId: string) {
        return this.sessions.taskThinkingChain(sessionId, taskId);
    }

    @Post(':id/feedback')
    feedback(
        @Param('id') sessionId: string,
        @Body() body: Record<string, unknown>,
    ): Promise<{ ok: boolean }> {
        return this.sessions.recordFeedback(sessionId, body);
    }
}
