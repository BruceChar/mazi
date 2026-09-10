import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ApiExceptionsFilter } from './common/api-error.js';
import { PostStatus200Interceptor } from './common/post-status.interceptor.js';
import { RuntimeModule } from './common/runtime.module.js';
import { ConversationsController } from './conversations/conversations.controller.js';
import { ConversationsService } from './conversations/conversations.service.js';
import { EventsController } from './events/events.controller.js';
import { GoalsController } from './goals/goals.controller.js';
import { GoalsService } from './goals/goals.service.js';
import { HealthController } from './health/health.controller.js';
import { RunsController } from './runs/runs.controller.js';
import { SessionsController } from './sessions/sessions.controller.js';
import { SessionsService } from './sessions/sessions.service.js';
import { WorkspacesController } from './workspaces/workspaces.controller.js';

/** 根模块：全局错误过滤（{error} 契约）+ 各 feature 控制器 */
@Module({
    imports: [RuntimeModule],
    controllers: [
        HealthController,
        RunsController,
        SessionsController,
        GoalsController,
        ConversationsController,
        EventsController,
        WorkspacesController,
    ],
    providers: [
        { provide: APP_FILTER, useClass: ApiExceptionsFilter },
        { provide: APP_INTERCEPTOR, useClass: PostStatus200Interceptor },
        SessionsService,
        GoalsService,
        ConversationsService,
    ],
})
export class AppModule {}
