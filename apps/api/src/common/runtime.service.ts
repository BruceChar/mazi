import 'reflect-metadata';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { MaziPaths, RuntimeConfig } from '@mazi/harness-runtime';
import {
    configOverview,
    ensureMaziDirs,
    HarnessRuntime,
    loadRuntimeConfig,
    toRuntimeConfig,
} from '@mazi/harness-runtime';
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { ApiError } from './api-error.js';

/**
 * ApiRuntimeService：API 侧组合根（docs/后端与存储设计.md v0.2 §10.2）。
 * 惰性装配 {@link HarnessRuntime}（领域/存储零改动），持有与旧实现一致的进程内串行执行锁，
 * 并在应用停机时关闭运行时。依赖单向：controller/service → 本服务 → @mazi/harness-runtime。
 */
@Injectable()
export class ApiRuntimeService implements OnApplicationShutdown {
    private readonly workspaces = new Map<string, HarnessRuntime>();
    private runtime: HarnessRuntime | undefined;
    private running = false;
    private workspaceRoot?: string;
    private workspacesState: {
        projects: { title: string; path: string; sessionIds?: string[] }[];
    } = { projects: [] };
    private readonly paths: MaziPaths = ensureMaziDirs();
    private readonly config: RuntimeConfig = toRuntimeConfig(loadRuntimeConfig(this.paths.home), {
        consoleEnabled: false,
    });

    /** MAZI_HOME 目录树（health/config 展示用） */
    get homePaths(): MaziPaths {
        return this.paths;
    }

    /** 是否正有会话在执行（串行锁状态） */
    get isRunning(): boolean {
        return this.running;
    }

    /** 按当前工作区惰性装配运行时；未绑定工作区时复用默认运行时 */
    harness(): HarnessRuntime {
        if (!this.workspaceRoot) {
            if (!this.runtime) {
                this.runtime = new HarnessRuntime(this.config);
            }
            return this.runtime as HarnessRuntime;
        }
        if (!this.workspaces.has(this.workspaceRoot)) {
            const workspaceRuntime = new HarnessRuntime(this.config, {
                workspaceRoot: this.workspaceRoot,
            });
            this.workspaces.set(this.workspaceRoot, workspaceRuntime);
        }
        return this.workspaces.get(this.workspaceRoot) as HarnessRuntime;
    }

    private get workspacesFile(): string {
        return join(this.paths.home, 'workspaces.json');
    }

    private readWorkspacesState(): { title: string; path: string; sessionIds?: string[] }[] {
        try {
            const parsed = JSON.parse(readFileSync(this.workspacesFile, 'utf8')) as {
                projects?: { title: string; path: string; sessionIds?: string[] }[];
            };
            this.workspacesState.projects = parsed.projects ?? [];
        } catch {
            this.workspacesState.projects = [];
        }
        return this.workspacesState.projects;
    }

    private writeWorkspacesState() {
        mkdirSync(dirname(this.workspacesFile), { recursive: true });
        writeFileSync(this.workspacesFile, JSON.stringify(this.workspacesState, null, 2));
    }

    setWorkspaceRoot(root?: string): void {
        if (!root) {
            this.workspaceRoot = undefined;
            return;
        }
        const resolved = join(root);
        if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
            throw new ApiError(400, '工作区路径不存在或不是目录');
        }
        this.workspaceRoot = resolved;
        const projects = this.readWorkspacesState();
        if (!projects.some((project) => project.path === resolved)) {
            projects.push({ title: basename(resolved), path: resolved });
            this.writeWorkspacesState();
        }
    }

    /** 对外项目列表：仅 title/path，Session 归属由 Conversation 字段承担 */
    projects(): { title: string; path: string }[] {
        return this.readWorkspacesState().map(({ title, path }) => ({ title, path }));
    }

    /** 迁移期读取：保留可能存在的旧 sessionIds 供 Conversation 回填 */
    legacyProjects(): { title: string; path: string; sessionIds?: string[] }[] {
        return this.readWorkspacesState();
    }

    /** 迁移完成：从 workspaces.json 中移除旧 sessionIds */
    stripLegacyProjectSessionIds(): void {
        const projects = this.readWorkspacesState();
        if (projects.some((project) => project.sessionIds !== undefined)) {
            this.workspacesState.projects = projects.map(({ title, path }) => ({ title, path }));
            this.writeWorkspacesState();
        }
    }

    renameProject(path: string, title: string): void {
        if (!title.trim()) {
            throw new ApiError(400, '缺少 title');
        }
        const projects = this.readWorkspacesState();
        const project = projects.find((item) => item.path === path);
        if (!project) {
            throw new ApiError(404, 'project not found');
        }
        project.title = title.trim();
        this.writeWorkspacesState();
    }

    get selectedWorkspaceRoot(): string | undefined {
        return this.workspaceRoot;
    }

    /** 配置总览（configOverview 同源） */
    overview(): { home: string; providers: string[]; hasProvidersFile: boolean } {
        return configOverview();
    }

    /** 与旧实现一致的进程内串行锁：已有会话执行时 → 409 */
    async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
        if (this.running) {
            throw new ApiError(409, '已有会话在运行，请稍候');
        }
        this.running = true;
        try {
            return await operation();
        } finally {
            this.running = false;
        }
    }

    async onApplicationShutdown(): Promise<void> {
        await this.runtime?.close();
    }
}
