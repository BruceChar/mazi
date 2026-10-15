import 'reflect-metadata';
import {
    listProjectWikis,
    type WikiEntry,
    type WikiProjectSummary,
    WikiService,
} from '@mazi/runtime';
import { Controller, Get, Query } from '@nestjs/common';
import { ApiRuntimeService } from '../common/runtime.service.js';

export interface WikiView {
    project: string;
    workspace: string;
    path: string;
    updatedAt?: string;
    snapshot: string | null;
    entries: WikiEntry[];
    empty: boolean;
}

/**
 * WikiController —— 项目 wiki 只读接口（docs/项目wiki设计.md §10）。
 * 写入侧在 runtime（会话内自动记录）；此处只做展示，缺省工作区 = 当前选中项目。
 */
@Controller('wiki')
export class WikiController {
    constructor(private readonly runtime: ApiRuntimeService) {}

    /** GET /api/wiki?workspace=<abs>：快照 + 变更日志；无 wiki 返回空态而非报错。 */
    @Get()
    view(@Query('workspace') workspace?: string): WikiView {
        const requested = (workspace ?? '').trim();
        const resolved =
            requested.length > 0
                ? requested
                : (this.runtime.selectedWorkspaceRoot ?? this.runtime.freeChatWorkspace);
        const service = new WikiService({
            home: this.runtime.homePaths.home,
            workspace: resolved,
        });
        const doc = service.snapshot();
        return {
            project: service.project ?? '',
            workspace: service.workspacePath ?? resolved,
            path: service.filePath ?? '',
            ...(doc?.updatedAt !== undefined ? { updatedAt: doc.updatedAt } : {}),
            snapshot: doc?.snapshot ?? null,
            entries: doc?.entries ?? [],
            empty: doc === undefined,
        };
    }

    /** GET /api/wiki/list：$MAZI_HOME/wiki 下的项目清单。 */
    @Get('list')
    list(): WikiProjectSummary[] {
        return listProjectWikis(this.runtime.homePaths.home);
    }
}
