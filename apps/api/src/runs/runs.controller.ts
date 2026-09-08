import 'reflect-metadata';
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import { SessionsService } from '../sessions/sessions.service.js';

/** POST /api/run：一站式 Goal 会话（create + execute + snapshot，进程内串行） */
@Controller()
export class RunsController {
    constructor(private readonly sessions: SessionsService) {}

    @Post('run')
    @HttpCode(200)
    run(@Body() body: Record<string, unknown>) {
        const input = typeof body.input === 'string' ? body.input.trim() : '';
        if (!input) {
            throw new ApiError(400, '缺少 input');
        }
        const userId = typeof body.userId === 'string' ? body.userId : undefined;
        return this.sessions.runOnce(input, userId);
    }
}
