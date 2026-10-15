import 'reflect-metadata';
import { Body, Controller, Delete, Get, Param, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { replayEvents, streamEvents } from '../events/sse.js';
import { ExperimentsService } from './experiments.service.js';

/**
 * AB 实验室接口（docs/AB测试设计.md §8.2）。
 * POST 创建即建好两臂会话（不执行）；POST :id/run 前台并行执行（审批可现场应答）；
 * 两臂 Trace 走实验独立存储：:`id/arms/:label/timeline|events`（不经过主会话端点）。
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

    /** 协作式终止：body.label 指定单臂，缺省两臂全停（空闲/已结束 → stopping 为空，幂等）。 */
    @Post(':id/stop')
    stop(@Param('id') experimentId: string, @Body() body: unknown) {
        return this.experiments.stop(experimentId, body);
    }

    /** 该臂 Goal 树快照（实验独立库）。 */
    @Get(':id/arms/:label/timeline')
    armTimeline(@Param('id') experimentId: string, @Param('label') label: string) {
        return this.experiments.armTimeline(experimentId, label);
    }

    /** 该臂事件流：follow != 1 回放 JSON；follow = 1 SSE（与主会话同一实现）。 */
    @Get(':id/arms/:label/events')
    async armEvents(
        @Param('id') experimentId: string,
        @Param('label') label: string,
        @Query('follow') follow?: string,
        @Res() reply?: FastifyReply,
    ): Promise<void> {
        const { bus, rootGoalId } = await this.experiments.armBus(experimentId, label);
        if (follow !== '1') {
            void reply?.send(replayEvents(bus, rootGoalId));
            return;
        }
        if (!reply) return;
        streamEvents(bus, rootGoalId, reply);
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
