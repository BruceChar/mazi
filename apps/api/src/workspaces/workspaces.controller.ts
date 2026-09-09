import 'reflect-metadata';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Body, Controller, Delete, Get, Patch, Post } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import Logger from '../common/log.js';
import { ApiRuntimeService } from '../common/runtime.service.js';
import { ConversationsService } from '../conversations/conversations.service.js';

const execFileAsync = promisify(execFile);

/** /api/workspaces：选择当前工作区，文件权限默认限定在所选目录 */
@Controller('workspaces')
export class WorkspacesController {
    private readonly logger = new Logger('workspaces');

    constructor(
        private readonly runtime: ApiRuntimeService,
        private readonly conversations: ConversationsService,
    ) {}

    @Post('current')
    selectCurrent(@Body() body: Record<string, unknown>): { path?: string } {
        const path =
            typeof body.path === 'string' && body.path.trim() ? body.path.trim() : undefined;
        this.runtime.setWorkspaceRoot(path);
        this.logger.log(`selectCurrent path=${path ?? '(none)'}`);
        return { path: this.runtime.selectedWorkspaceRoot };
    }

    @Get('current')
    current(): {
        path?: string;
        projects?: { title: string; path: string }[];
    } {
        const result = {
            path: this.runtime.selectedWorkspaceRoot,
            projects: this.runtime.projects(),
        };
        this.logger.debug(`current path=${result.path ?? '-'} projects=${result.projects?.length ?? 0}`);
        return result;
    }

    /** 重命名项目展示名（body: path/title） */
    @Patch('project')
    renameProject(@Body() body: Record<string, unknown>): {
        projects: { title: string; path: string }[];
    } {
        const path = typeof body.path === 'string' ? body.path : '';
        const title = typeof body.title === 'string' ? body.title : '';
        this.runtime.renameProject(path, title);
        this.logger.log(`renameProject path=${JSON.stringify(path)} title=${JSON.stringify(title)}`);
        return { projects: this.runtime.projects() };
    }

    /** 删除工作区项目配置（仅配置；对话记录解除归属后保留） */
    @Delete('project')
    removeProject(@Body() body: Record<string, unknown>): {
        projects: { title: string; path: string }[];
    } {
        const path = typeof body.path === 'string' ? body.path : '';
        this.runtime.removeProjectConfig(path);
        this.conversations.detachWorkspace(path);
        this.logger.log(`removeProject path=${JSON.stringify(path)} (conversations detached)`);
        return { projects: this.runtime.projects() };
    }

    /** 弹出系统目录选择器（macOS: osascript 选文件夹对话框） */
    @Post('pick')
    async pick(): Promise<{
        path?: string;
        projects?: { title: string; path: string }[];
    }> {
        try {
            const { stdout } = await execFileAsync('osascript', [
                '-e',
                'POSIX path of (choose folder)',
            ]);
            const path = stdout.trim();
            if (!path) {
                return { path: undefined };
            }
            this.runtime.setWorkspaceRoot(path);
            this.logger.log(`pick selected path=${JSON.stringify(path)}`);
            return {
                path: this.runtime.selectedWorkspaceRoot,
                projects: this.runtime.projects(),
            };
        } catch (error) {
            if ((error as { code?: string }).code === 'ENOENT') {
                throw new ApiError(500, '当前系统不支持系统目录选择器');
            }
            // 用户取消选择
            if (String(error).includes('canceled') || String(error).includes('User canceled')) {
                this.logger.debug('pick cancelled by user');
                return { path: undefined };
            }
            this.logger.error(`pick failed: ${String(error)}`);
            throw new ApiError(500, `目录选择失败：${String(error)}`);
        }
    }
}
