import 'reflect-metadata';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import { ApiRuntimeService } from '../common/runtime.service.js';

const execFileAsync = promisify(execFile);

/** /api/workspaces：选择当前工作区，文件权限默认限定在所选目录 */
@Controller('workspaces')
export class WorkspacesController {
    constructor(private readonly runtime: ApiRuntimeService) {}

    @Post('current')
    selectCurrent(@Body() body: Record<string, unknown>): { path?: string } {
        const path =
            typeof body.path === 'string' && body.path.trim() ? body.path.trim() : undefined;
        this.runtime.setWorkspaceRoot(path);
        return { path: this.runtime.selectedWorkspaceRoot };
    }

    @Get('current')
    current(): {
        path?: string;
        projects?: { title: string; path: string }[];
    } {
        return {
            path: this.runtime.selectedWorkspaceRoot,
            projects: this.runtime.projects(),
        };
    }

    /** 重命名项目展示名（body: path/title） */
    @Patch('project')
    renameProject(@Body() body: Record<string, unknown>): {
        projects: { title: string; path: string }[];
    } {
        const path = typeof body.path === 'string' ? body.path : '';
        const title = typeof body.title === 'string' ? body.title : '';
        this.runtime.renameProject(path, title);
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
                return { path: undefined };
            }
            throw new ApiError(500, `目录选择失败：${String(error)}`);
        }
    }
}
