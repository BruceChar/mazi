import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ApiExceptionsFilter } from './common/api-error.js';
import { RuntimeModule } from './common/runtime.module.js';
import { HealthController } from './health/health.controller.js';

/** 根模块：全局错误过滤（{error} 契约）+ 各 feature 控制器 */
@Module({
    imports: [RuntimeModule],
    controllers: [HealthController],
    providers: [{ provide: APP_FILTER, useClass: ApiExceptionsFilter }],
})
export class AppModule {}
