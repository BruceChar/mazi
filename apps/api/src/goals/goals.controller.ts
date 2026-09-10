import 'reflect-metadata';
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { GoalsService } from './goals.service.js';

/** /api/goals*：Goal 会话运行（POST /goals）与树快照（GET /goals/:rootGoalId） */
@Controller('goals')
export class GoalsController {
    constructor(private readonly goals: GoalsService) {}

    @Post()
    run(@Body() body: Record<string, unknown>) {
        return this.goals.run(body);
    }

    @Get(':rootGoalId')
    snapshot(@Param('rootGoalId') rootGoalId: string) {
        return this.goals.snapshot(rootGoalId);
    }
}
