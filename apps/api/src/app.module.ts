import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ApprovalsController } from './approvals/approvals.controller.js';
import { CapabilitiesController } from './capabilities/capabilities.controller.js';
import { CatalogController } from './catalog/catalog.controller.js';
import { ApiExceptionsFilter } from './common/api-error.js';
import { PostStatus200Interceptor } from './common/post-status.interceptor.js';
import { RuntimeModule } from './common/runtime.module.js';
import { ConversationsController } from './conversations/conversations.controller.js';
import { ConversationsService } from './conversations/conversations.service.js';
import { EventsController } from './events/events.controller.js';
import { ExperimentsController } from './experiments/experiments.controller.js';
import { ExperimentsService } from './experiments/experiments.service.js';
import { FeaturesController } from './features/features.controller.js';
import { GoalsController } from './goals/goals.controller.js';
import { GoalsService } from './goals/goals.service.js';
import { HealthController } from './health/health.controller.js';
import { IterationsController } from './iterations/iterations.controller.js';
import { IterationsService } from './iterations/iterations.service.js';
import { LedgerController } from './ledger/ledger.controller.js';
import { LedgerService } from './ledger/ledger.service.js';
import { QuestionsController } from './questions/questions.controller.js';
import { QuestionsService } from './questions/questions.service.js';
import { RunsController } from './runs/runs.controller.js';
import { SessionsController } from './sessions/sessions.controller.js';
import { SessionsService } from './sessions/sessions.service.js';
import { StorageController } from './storage/storage.controller.js';
import { StorageService } from './storage/storage.service.js';
import { SystemController } from './system/system.controller.js';
import { SystemService } from './system/system.service.js';
import { UsersController } from './users/users.controller.js';
import { UsersService } from './users/users.service.js';
import { WikiController } from './wiki/wiki.controller.js';
import { WorkspacesController } from './workspaces/workspaces.controller.js';

/** 根模块：全局错误过滤（{error} 契约）+ 各 feature 控制器 */
@Module({
    imports: [RuntimeModule],
    controllers: [
        HealthController,
        CatalogController,
        CapabilitiesController,
        FeaturesController,
        ExperimentsController,
        RunsController,
        SessionsController,
        GoalsController,
        ConversationsController,
        EventsController,
        WorkspacesController,
        ApprovalsController,
        StorageController,
        IterationsController,
        UsersController,
        LedgerController,
        QuestionsController,
        SystemController,
        WikiController,
    ],
    providers: [
        { provide: APP_FILTER, useClass: ApiExceptionsFilter },
        { provide: APP_INTERCEPTOR, useClass: PostStatus200Interceptor },
        SessionsService,
        GoalsService,
        ConversationsService,
        StorageService,
        IterationsService,
        UsersService,
        LedgerService,
        QuestionsService,
        ExperimentsService,
        // SystemService 构造器接受可注入 options（默认走真实 git/fs）；缺省参数不适配 Nest DI，显式工厂装配。
        { provide: SystemService, useFactory: () => new SystemService() },
    ],
})
export class AppModule {}
