import 'reflect-metadata';
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ConversationsService } from '../conversations/conversations.service.js';
import { EvalService } from './eval.service.js';

@Controller('eval')
export class EvalController {
    constructor(
        private readonly evaluations: EvalService,
        private readonly conversations: ConversationsService,
    ) {}

    @Get('tasks')
    tasks() {
        const tasks = this.evaluations.tasks();
        return {
            dataset: 'p0-baseline',
            version: 1,
            tasks,
        };
    }

    @Post('runs')
    run(@Body() body: Record<string, unknown>) {
        return this.evaluations.run(body);
    }

    @Get('runs')
    async runs() {
        return { runs: await this.evaluations.listRuns() };
    }

    @Get('runs/:id')
    async runDetail(@Param('id') runId: string) {
        return this.evaluations.runDetail(runId);
    }

    @Get('runs/:id/report')
    async report(@Param('id') runId: string) {
        return this.evaluations.report(runId);
    }

    @Get('sessions')
    async sessions(
        @Query('projectId') projectId?: string,
        @Query('source') source?: string,
        @Query('from') from?: string,
        @Query('to') to?: string,
        @Query('limit') limit?: string,
    ) {
        const fromMs = Number(from);
        const toMs = Number(to);
        const parsedLimit = Number(limit);
        return {
            sessions: await this.evaluations.sessionEvaluations({
                ...(projectId ? { projectId } : {}),
                ...(source === 'session' || source === 'ab' ? { source } : {}),
                ...(Number.isFinite(fromMs) && fromMs > 0 ? { from: fromMs } : {}),
                ...(Number.isFinite(toMs) && toMs > 0 ? { to: toMs } : {}),
                ...(Number.isFinite(parsedLimit) && parsedLimit > 0
                    ? { limit: Math.min(500, Math.floor(parsedLimit)) }
                    : {}),
            }),
        };
    }

    @Post('sessions/reconcile')
    reconcileSessions() {
        return this.evaluations.reconcileSessions(this.conversations.allRuns());
    }

    @Get('sessions/:id')
    session(@Param('id') rootGoalId: string) {
        return this.evaluations.sessionEvaluation(rootGoalId);
    }
}
