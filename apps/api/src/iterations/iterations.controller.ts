import 'reflect-metadata';
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { IterationsService } from './iterations.service.js';

/** /api/iterations*：TOC 冻结、独立分析、反馈（Iterations 面板） */
@Controller('iterations')
export class IterationsController {
    constructor(private readonly iterations: IterationsService) {}

    @Get()
    list() {
        return this.iterations.list();
    }

    @Post('analyses')
    analyze(@Body() body: Record<string, unknown>) {
        return this.iterations.analyze(body);
    }

    @Post(':analyzeId/feedback')
    feedback(@Param('analyzeId') analyzeId: string, @Body() body: Record<string, unknown>) {
        return this.iterations.addFeedback(analyzeId, body);
    }
}
