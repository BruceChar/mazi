import 'reflect-metadata';
import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ExperimentsService } from './experiments.service.js';

/**
 * 对照实验接口（docs/AB测试设计.md §8.2）。
 * POST 创建即执行（复用 PostStatus200Interceptor：POST 201 → 200）。
 * 两臂 Trace 复用既有端点：GET /api/sessions/:rootGoalId/timeline 与 /api/events/:rootGoalId。
 */
@Controller('experiments')
export class ExperimentsController {
    constructor(private readonly experiments: ExperimentsService) {}

    @Get()
    list() {
        return this.experiments.list();
    }

    @Post()
    create(@Body() body: unknown) {
        return this.experiments.create(body);
    }

    @Get(':id')
    detail(@Param('id') experimentId: string) {
        return this.experiments.detail(experimentId);
    }

    /** 前台执行尚未完成的臂（并行；请求保持到两臂结束，期间 UI 订阅事件流并应答审批）。 */
    @Post(':id/run')
    run(@Param('id') experimentId: string) {
        return this.experiments.execute(experimentId);
    }

    @Post(':id/rerun')
    rerun(@Param('id') experimentId: string) {
        return this.experiments.rerun(experimentId);
    }

    @Post(':id/reviews')
    review(@Param('id') experimentId: string, @Body() body: unknown) {
        return this.experiments.review(experimentId, body);
    }

    @Delete(':id')
    remove(@Param('id') experimentId: string) {
        return this.experiments.remove(experimentId);
    }
}
