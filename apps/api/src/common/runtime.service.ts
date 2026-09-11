import 'reflect-metadata';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { CatalogChange } from '@mazi/core';
import type {
    MaziPaths,
    ProviderModelInfo,
    ProviderModelPricing,
    RuntimeConfig,
} from '@mazi/runtime';
import {
    builtinModelsFor,
    CatalogService,
    configOverview,
    ensureMaziDirs,
    FileCatalogStore,
    HarnessRuntime,
    loadRuntimeConfig,
    observedCatalogFromProviderConfigs,
    toRuntimeConfig,
} from '@mazi/runtime';
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { ApiError } from './api-error.js';
import Logger from './log.js';

/** ProviderModelInfo → providers.json models 条目。 */
function modelEntryOf(info: ProviderModelInfo): Record<string, unknown> {
    const caps = info.capabilities;
    return {
        id: info.id,
        name: info.name,
        ...(caps.maxInputTokens !== undefined ? { contextWindow: caps.maxInputTokens } : {}),
        ...(caps.maxOutputTokens !== undefined ? { maxTokens: caps.maxOutputTokens } : {}),
        supportsTools: caps.supportsToolCalls,
        supportsThinking: caps.supportsReasoning === true,
        supportsVision: caps.inputTypes.includes('image'),
    };
}

/** 用目录默认模型价格刷新 provider 级 pricing.base（保留 tiers/version，缺失补默认）。 */
function applyCatalogPricing(
    provider: Record<string, unknown>,
    pricing: ProviderModelPricing,
): boolean {
    const current = (provider.pricing ?? {}) as {
        currency?: string;
        base?: Record<string, number>;
        tiers?: unknown[];
        effectiveAt?: number;
        version?: string;
    };
    const next = {
        ...current,
        currency: 'USD' as const,
        base: {
            ...(current.base ?? {}),
            ...(pricing.inputPerMTok !== undefined ? { inputPerMTok: pricing.inputPerMTok } : {}),
            ...(pricing.outputPerMTok !== undefined
                ? { outputPerMTok: pricing.outputPerMTok }
                : {}),
            ...(pricing.cacheReadPerMTok !== undefined
                ? { cacheReadPerMTok: pricing.cacheReadPerMTok }
                : {}),
            ...(pricing.cacheWritePerMTok !== undefined
                ? { cacheWritePerMTok: pricing.cacheWritePerMTok }
                : {}),
        },
        tiers: current.tiers ?? [],
        effectiveAt: current.effectiveAt ?? 0,
        version: current.version ?? 'catalog',
    };
    if (JSON.stringify(next) === JSON.stringify(current)) {
        return false;
    }
    provider.pricing = next;
    return true;
}

/**
 * ApiRuntimeService：API 侧组合根（docs/后端与存储设计.md v0.2 §10.2）。
 * 惰性装配 {@link HarnessRuntime}（领域/存储零改动），持有与旧实现一致的进程内串行执行锁，
 * 并在应用停机时关闭运行时。依赖单向：controller/service → 本服务 → @mazi/runtime。
 */
@Injectable()
export class ApiRuntimeService implements OnApplicationShutdown {
    private readonly logger = new Logger('runtime');
    private readonly workspaces = new Map<string, HarnessRuntime>();
    private runtime: HarnessRuntime | undefined;
    private catalogInstance: CatalogService | undefined;
    private catalogOpening: Promise<CatalogService> | undefined;
    private running = false;
    private workspaceRoot?: string;
    private workspacesState: {
        projects: { title: string; path: string; sessionIds?: string[] }[];
    } = { projects: [] };
    private readonly paths: MaziPaths = ensureMaziDirs();
    private config: RuntimeConfig;

    constructor() {
        // 启动时按 pi-ai 内置目录同步一次 providers.json 的模型列表（失败不阻断启动）。
        try {
            this.syncProviderModels();
        } catch (error) {
            this.logger.warn(`syncProviderModels on boot failed: ${String(error)}`);
        }
        this.config = toRuntimeConfig(loadRuntimeConfig(this.paths.home), {
            consoleEnabled: false,
        });
    }

    /**
     * 按 pi-ai 内置目录同步 providers.json 的 models 列表（best-effort）。
     * 未知厂商（目录无此 provider）保留原 models，不覆盖。
     * @returns 是否发生变更
     */
    syncProviderModels(): boolean {
        this.logger.log('syncProviderModels: start');
        const file = this.paths.providersFile;
        this.logger.debug(`syncProviderModels: file=${file}`);
        if (!existsSync(file)) {
            return false;
        }
        let parsed: { providers?: Array<Record<string, unknown>> };
        try {
            parsed = JSON.parse(readFileSync(file, 'utf8')) as typeof parsed;
        } catch (error) {
            this.logger.warn(`read providers.json failed: ${String(error)}`);
            return false;
        }
        const providers = parsed.providers ?? [];
        let changed = false;
        for (const provider of providers) {
            const vendor = (provider.driver as { provider?: string } | undefined)?.provider;
            if (!vendor) continue;
            const infos = builtinModelsFor(vendor);
            if (infos.length === 0) continue;
            const existing = Array.isArray(provider.models)
                ? (provider.models as Array<Record<string, unknown>>)
                : [];
            const existingById = new Map(existing.map((model) => [String(model.id), model]));
            // 目录模型优先；目录外（厂商新模型 / 自定义）保留在尾部，绝不删除
            const merged = [
                ...infos.map((info) => existingById.get(info.id) ?? modelEntryOf(info)),
                ...existing.filter((model) => !infos.some((info) => info.id === model.id)),
            ];
            if (JSON.stringify(merged) !== JSON.stringify(existing)) {
                provider.models = merged;
                changed = true;
            }
            const pricing = infos[0]?.pricing;
            if (pricing && applyCatalogPricing(provider, pricing)) {
                changed = true;
            }
        }
        if (changed) {
            writeFileSync(file, JSON.stringify(parsed, null, 2));
            this.logger.log('syncProviderModels: models/pricing updated from provider catalog');
        }
        return changed;
    }

    /**
     * 手动同步：刷新目录模型 → 重新加载配置 → 丢弃已装配 runtime（下次按新配置重建）。
     * 会话执行中不重建，避免打断在跑的 run。
     */
    async syncConfig(): Promise<ReturnType<typeof configOverview>> {
        this.syncProviderModels();
        this.config = toRuntimeConfig(loadRuntimeConfig(this.paths.home), {
            consoleEnabled: false,
        });
        if (!this.running) {
            const stale = [this.runtime, ...this.workspaces.values()];
            this.runtime = undefined;
            this.workspaces.clear();
            for (const runtime of stale) {
                if (runtime) await runtime.close();
            }
        }
        return this.overview();
    }

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
                this.attachCatalog(this.runtime);
                this.logger.debug('harness: default runtime assembled');
            }
            return this.runtime as HarnessRuntime;
        }
        if (!this.workspaces.has(this.workspaceRoot)) {
            const workspaceRuntime = new HarnessRuntime(this.config, {
                workspaceRoot: this.workspaceRoot,
            });
            this.attachCatalog(workspaceRuntime);
            this.workspaces.set(this.workspaceRoot, workspaceRuntime);
            this.logger.debug(`harness: workspace runtime assembled root=${this.workspaceRoot}`);
        }
        return this.workspaces.get(this.workspaceRoot) as HarnessRuntime;
    }

    /** 目录服务异步就绪后接入运行时；就绪前的请求不落账本（best-effort，不阻断执行）。 */
    private attachCatalog(runtime: HarnessRuntime): void {
        void this.catalog()
            .then((service) => runtime.setCatalog(service))
            .catch((error) => this.logger.warn(`attachCatalog failed: ${String(error)}`));
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
            this.logger.log('setWorkspaceRoot → (none)');
            return;
        }
        const resolved = join(root);
        if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
            throw new ApiError(400, '工作区路径不存在或不是目录');
        }
        this.workspaceRoot = resolved;
        this.logger.log(`setWorkspaceRoot → ${resolved}`);
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

    /** 删除工作区项目配置（仅 workspaces.json；对话记录由调用方另行解除归属） */
    removeProjectConfig(path: string): void {
        const projects = this.readWorkspacesState();
        const project = projects.find((item) => item.path === path);
        if (!project) {
            throw new ApiError(404, 'project not found');
        }
        this.workspacesState.projects = projects.filter((item) => item.path !== path);
        this.writeWorkspacesState();
    }

    get selectedWorkspaceRoot(): string | undefined {
        return this.workspaceRoot;
    }

    /** 配置总览 */
    overview(): {
        home: string;
        providers: Array<{ id: string; models: Array<{ id: string; name?: string }> }>;
        hasProvidersFile: boolean;
    } {
        return configOverview();
    }

    /**
     * 惰性打开目录服务：文件存储于 $MAZI_HOME/catalog；首次为空时按 providers.json 走一遍
     * sync 管线（source=manual-import，设计文档 §12）。并发调用共享同一次打开。
     */
    async catalog(): Promise<CatalogService> {
        if (this.catalogInstance !== undefined) return this.catalogInstance;
        this.catalogOpening ??= this.openCatalog();
        this.catalogInstance = await this.catalogOpening;
        return this.catalogInstance;
    }

    private async openCatalog(): Promise<CatalogService> {
        const service = await CatalogService.open({
            store: new FileCatalogStore(join(this.paths.home, 'catalog')),
        });
        if (service.epoch() === 0) {
            await this.importCatalog(service, 'manual-import');
        }
        return service;
    }

    /** 用当前 providers.json 重新走 sync 管线（manual-import 首次 / operator 手动刷新）。 */
    private async importCatalog(
        service: CatalogService,
        source: 'manual-import' | 'operator',
    ): Promise<{ epoch: number; changed: boolean; changes: CatalogChange[] }> {
        const { providers } = loadRuntimeConfig(this.paths.home);
        const { catalog, driverConfigs } = observedCatalogFromProviderConfigs(providers);
        if (catalog.providers.length === 0) {
            return { epoch: service.epoch(), changed: false, changes: [] };
        }
        const result = await service.sync(catalog, { source });
        for (const driverConfig of driverConfigs) {
            await service.setDriverConfig(driverConfig);
        }
        return result;
    }

    /** POST /api/catalog/sync：把 providers.json 的模型/价格重新同步进目录并返回 diff。 */
    async syncCatalog(): Promise<{ epoch: number; changed: boolean; changes: CatalogChange[] }> {
        const service = await this.catalog();
        return this.importCatalog(service, 'operator');
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
