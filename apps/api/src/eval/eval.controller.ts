import 'reflect-metadata';
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { EvalService } from './eval.service.js';

@Controller('eval')
export class EvalController {
    constructor(private readonly evaluations: EvalService) {}

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
    runs() {
        return { runs: this.evaluations.listRuns() };
    }

    @Get('runs/:id')
    runDetail(@Param('id') runId: string) {
        return this.evaluations.runDetail(runId);
    }

    @Get('runs/:id/report')
    report(@Param('id') runId: string) {
        return this.evaluations.report(runId);
    }
}
