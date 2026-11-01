import 'reflect-metadata';
import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import { ApiRuntimeService } from '../common/runtime.service.js';

@Controller('projects')
export class ProjectsController {
    constructor(private readonly runtime: ApiRuntimeService) {}

    @Get(':id/blackboard')
    async blackboard(@Param('id') projectId: string, @Query('workspace') workspace?: string) {
        if (workspace) this.runtime.setWorkspaceRoot(workspace);
        const board = await this.runtime.harness().projectBlackboard(projectId);
        if (board === undefined) throw new ApiError(400, '项目黑板需要工作区');
        return { board };
    }

    @Post(':id/blackboard/reconcile')
    async reconcile(@Param('id') projectId: string, @Query('workspace') workspace?: string) {
        if (workspace) this.runtime.setWorkspaceRoot(workspace);
        const board = await this.runtime.harness().reconcileProjectBlackboard(projectId);
        if (board === undefined) throw new ApiError(400, '项目黑板需要工作区');
        return { board };
    }
}
