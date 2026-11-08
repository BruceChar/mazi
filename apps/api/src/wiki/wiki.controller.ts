import 'reflect-metadata';
import {
    listProjectWikis,
    type ProjectBlackboard,
    type ProjectWikiOperationResult,
    ProjectWikiService,
    projectIdForWorkspace,
    type WikiEntry,
    type WikiProjectSummary,
    WikiService,
} from '@mazi/runtime';
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import { ApiRuntimeService } from '../common/runtime.service.js';
import {
    ProjectWikiMaintenanceService,
    type ProjectWikiOperationView,
} from './maintenance.service.js';
import { type ProjectWikiRepository, readProjectWiki } from './repository.js';

export interface WikiView {
    project: string;
    workspace: string;
    path: string;
    updatedAt?: string;
    snapshot: string | null;
    entries: WikiEntry[];
    empty: boolean;
    blackboard: ProjectBlackboard | null;
    repository: ProjectWikiRepository | null;
    operation: ProjectWikiOperationView | null;
    backgroundSync: ProjectWikiOperationView | null;
}

/**
 * WikiController —— 项目 wiki 只读接口（docs/项目wiki设计.md §10）。
 * 写入侧在 runtime（会话内自动记录）；此处只做展示，缺省工作区 = 当前选中项目。
 */
@Controller('wiki')
export class WikiController {
    constructor(
        private readonly runtime: ApiRuntimeService,
        private readonly maintenance: ProjectWikiMaintenanceService,
    ) {}

    /** GET /api/wiki?workspace=<abs>：快照 + 变更日志；无 wiki 返回空态而非报错。 */
    @Get()
    async view(@Query('workspace') workspace?: string): Promise<WikiView> {
        const resolved = this.resolveWorkspace(workspace);
        this.runtime.setWorkspaceRoot(resolved);
        const service = new WikiService({
            home: this.runtime.homePaths.home,
            workspace: resolved,
        });
        const doc = service.snapshot();
        const blackboard = await this.runtime
            .harness()
            .projectBlackboard(projectIdForWorkspace(resolved));
        const repository = readProjectWiki(resolved);
        return {
            project: service.project ?? '',
            workspace: service.workspacePath ?? resolved,
            path: service.filePath ?? '',
            ...(doc?.updatedAt !== undefined ? { updatedAt: doc.updatedAt } : {}),
            snapshot: doc?.snapshot ?? null,
            entries: doc?.entries ?? [],
            empty: doc === undefined && repository === undefined,
            blackboard: blackboard ?? null,
            repository: repository ?? null,
            operation: this.maintenance.current(resolved) ?? null,
            backgroundSync: this.maintenance.currentSync(resolved) ?? null,
        };
    }

    @Post('reconcile')
    async reconcile(@Query('workspace') workspace?: string): Promise<WikiView> {
        const resolved = this.resolveWorkspace(workspace);
        this.runtime.setWorkspaceRoot(resolved);
        await this.runtime.harness().reconcileProjectBlackboard(projectIdForWorkspace(resolved));
        return this.view(resolved);
    }

    /** POST /api/wiki/init：启动 Agent 读取项目并完成首次填库。 */
    @Post('init')
    init(@Query('workspace') workspace?: string): ProjectWikiOperationView {
        return this.start('init', workspace);
    }

    /** POST /api/wiki/update：启动 Agent 检查漂移并核对 claims / oid。 */
    @Post('update')
    update(@Query('workspace') workspace?: string): ProjectWikiOperationView {
        return this.start('update', workspace);
    }

    @Get('operations/:id')
    operation(@Param('id') id: string): ProjectWikiOperationView {
        return this.maintenance.get(id);
    }

    @Post('claims/:id/correct')
    async correctClaim(
        @Param('id') id: string,
        @Body() body: Record<string, unknown>,
        @Query('workspace') workspace?: string,
    ): Promise<ProjectWikiOperationResult> {
        const resolved = this.resolveWorkspace(workspace);
        const newId = typeof body.newId === 'string' ? body.newId.trim() : '';
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
        const evidence = Array.isArray(body.evidence)
            ? body.evidence
                  .filter((entry): entry is string => typeof entry === 'string')
                  .map((file) => ({ file }))
            : [];
        try {
            return await new ProjectWikiService({ workspace: resolved }).correctClaim({
                oldId: id,
                newId,
                text,
                evidence,
                reason,
            });
        } catch (error) {
            throw new ApiError(400, error instanceof Error ? error.message : String(error));
        }
    }

    @Post('claims/:id/forget')
    async forgetClaim(
        @Param('id') id: string,
        @Body() body: Record<string, unknown>,
        @Query('workspace') workspace?: string,
    ): Promise<ProjectWikiOperationResult> {
        const resolved = this.resolveWorkspace(workspace);
        const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
        try {
            return await new ProjectWikiService({ workspace: resolved }).forgetClaim({
                id,
                reason,
            });
        } catch (error) {
            throw new ApiError(400, error instanceof Error ? error.message : String(error));
        }
    }

    @Post('claims/:id/verify')
    async verifyClaim(
        @Param('id') id: string,
        @Query('workspace') workspace?: string,
    ): Promise<ProjectWikiOperationResult> {
        const resolved = this.resolveWorkspace(workspace);
        try {
            return await new ProjectWikiService({ workspace: resolved }).verifyClaims({
                ids: [id],
            });
        } catch (error) {
            throw new ApiError(400, error instanceof Error ? error.message : String(error));
        }
    }

    /** GET /api/wiki/list：$MAZI_HOME/wiki 下的项目清单。 */
    @Get('list')
    list(): WikiProjectSummary[] {
        return listProjectWikis(this.runtime.homePaths.home);
    }

    private start(kind: 'init' | 'update', workspace?: string): ProjectWikiOperationView {
        const resolved = this.resolveWorkspace(workspace);
        this.runtime.setWorkspaceRoot(resolved);
        return this.maintenance.start(kind, resolved);
    }

    private resolveWorkspace(workspace?: string): string {
        const requested = (workspace ?? '').trim();
        return requested.length > 0
            ? requested
            : (this.runtime.selectedWorkspaceRoot ?? this.runtime.freeChatWorkspace);
    }
}
