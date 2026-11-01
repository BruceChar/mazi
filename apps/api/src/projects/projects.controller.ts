import 'reflect-metadata';
import { projectIdForWorkspace } from '@mazi/runtime';
import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import { ApiRuntimeService } from '../common/runtime.service.js';

@Controller('projects')
export class ProjectsController {
    constructor(private readonly runtime: ApiRuntimeService) {}

    @Get('blackboard')
    async workspaceBlackboard(@Query('workspace') workspace?: string) {
        const target = workspace || this.runtime.selectedWorkspaceRoot;
        if (!target) throw new ApiError(400, '项目黑板需要工作区');
        this.runtime.setWorkspaceRoot(target);
        const board = await this.runtime.harness().projectBlackboard(
            projectIdForWorkspace(target),
        );
        if (board === undefined) throw new ApiError(400, '项目黑板需要工作区');
        return { board };
    }

    @Post('blackboard/reconcile')
    async reconcileWorkspaceBlackboard(@Query('workspace') workspace?: string) {
        const target = workspace || this.runtime.selectedWorkspaceRoot;
        if (!target) throw new ApiError(400, '项目黑板需要工作区');
        this.runtime.setWorkspaceRoot(target);
        const board = await this.runtime.harness().reconcileProjectBlackboard(
            projectIdForWorkspace(target),
        );
        if (board === undefined) throw new ApiError(400, '项目黑板需要工作区');
        return { board };
    }

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
