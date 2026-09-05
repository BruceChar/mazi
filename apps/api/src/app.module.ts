import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ApiExceptionsFilter } from './common/api-error.js';
import { RuntimeModule } from './common/runtime.module.js';
import { EventsController } from './events/events.controller.js';
import { HealthController } from './health/health.controller.js';
import { RunsController } from './runs/runs.controller.js';
import { SessionsController } from './sessions/sessions.controller.js';
import { SessionsService } from './sessions/sessions.service.js';
import { UsersController } from './users/users.controller.js';
import { UsersService } from './users/users.service.js';

/** 根模块：全局错误过滤（{error} 契约）+ 各 feature 控制器 */
@Module({
    imports: [RuntimeModule],
    controllers: [
        HealthController,
        RunsController,
        SessionsController,
        UsersController,
        EventsController,
    ],
    providers: [
        { provide: APP_FILTER, useClass: ApiExceptionsFilter },
        SessionsService,
        UsersService,
    ],
})
export class AppModule {}
