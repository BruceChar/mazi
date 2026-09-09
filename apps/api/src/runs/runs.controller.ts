import 'reflect-metadata';
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import Logger from '../common/log.js';
import { SessionsService } from '../sessions/sessions.service.js';

/** POST /api/run：一站式 Goal 会话（create + execute + snapshot，进程内串行） */
@Controller()
export class RunsController {
    private readonly logger = new Logger('runs');

    constructor(private readonly sessions: SessionsService) {}

    @Post('run')
    @HttpCode(200)
    run(@Body() body: Record<string, unknown>) {
        const input = typeof body.input === 'string' ? body.input.trim() : '';
        if (!input) {
            throw new ApiError(400, '缺少 input');
        }
        const userId = typeof body.userId === 'string' ? body.userId : undefined;
        this.logger.log(`POST /api/run input=${JSON.stringify(input.slice(0, 80))} user=${userId ?? '-'}`);
        return this.sessions.runOnce(input, userId);
    }
}
