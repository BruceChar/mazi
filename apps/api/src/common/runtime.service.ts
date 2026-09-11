import 'reflect-metadata';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { CatalogChange, PermissionLevel } from '@mazi/core';
import type {
    MaziPaths,
    ProviderModelInfo,
    ProviderModelPricing,
    RuntimeConfig,
} from '@mazi/runtime';
import {
    ApprovalBroker,
    type ApprovalSettlement,
    builtinModelsFor,
    CatalogService,
    configOverview,
    discoverModels,
    ensureMaziDirs,
    FileCatalogStore,
    HarnessRuntime,
    loadRuntimeConfig,
    observedCatalogFromProviderConfigs,
    type PendingApproval,
    saveRuntimeSettings,
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

function driverProviderOf(provider: Record<string, unknown>): string | undefined {
    const driver = provider.driver as { provider?: unknown } | undefined;
    return typeof driver?.provider === 'string' && driver.provider.length > 0
        ? driver.provider
        : undefined;
}

function driverModelOf(provider: Record<string, unknown>): string | undefined {
    const driver = provider.driver as { model?: unknown } | undefined;
    return typeof driver?.model === 'string' ? driver.model : undefined;
}

function driverBaseUrlOf(provider: Record<string, unknown>): string | undefined {
    const driver = provider.driver as { baseUrl?: unknown } | undefined;
    return typeof driver?.baseUrl === 'string' && driver.baseUrl.length > 0
        ? driver.baseUrl
        : undefined;
}

/**
 * **权威替换** provider.models 为发现的 id 列表（保序、保留同 id 的既有元数据）。
 * 与旧行为的关键差异：厂商不再返回的陈旧 id 会被移除（否则 deepseek-v41-flash 会永久残留）。
 * 若 driver.model 不在新列表内，重置为新列表首个模型。
 */
function applyModelList(
    provider: Record<string, unknown>,
    ids: readonly string[],
    metadata: readonly ProviderModelInfo[],
): boolean {
    const existing = Array.isArray(provider.models)
        ? (provider.models as Array<Record<string, unknown>>)
        : [];
    const existingById = new Map(existing.map((model) => [String(model.id), model]));
    const metaById = new Map(metadata.map((info) => [info.id, info]));
    const next = ids.map((id) => {
        const prior = existingById.get(id);
        if (prior !== undefined) return prior;
        const info = metaById.get(id);
        return info !== undefined ? modelEntryOf(info) : { id, name: id };
    });
    const driver = provider.driver as { model?: unknown } | undefined;
    const currentDefault = driverModelOf(provider);
    if (driver !== undefined && (currentDefault === undefined || !ids.includes(currentDefault))) {
        if (ids[0] !== undefined) driver.model = ids[0];
    }
    if (JSON.stringify(next) === JSON.stringify(existing)) {
        return false;
    }
    provider.models = next;
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
    /** 每个运行时一个审批 broker（人审 seam 注入点）。 */
    private readonly approvalBrokers = new Map<HarnessRuntime, ApprovalBroker>();
    private runtime: HarnessRuntime | undefined;
    private catalogInstance: CatalogService | undefined;
    private catalogOpening: Promise<CatalogService> | undefined;
    private running = false;
    private workspaceRoot?: string;
    /** 随心聊（未选项目）默认工作区；可经设置修改，持久化在 workspaces.json。 */
    private freeChatWorkspaceValue: string;
    private workspacesState: {
        projects: { title: string; path: string; sessionIds?: string[] }[];
        freeChatWorkspace?: string;
    } = { projects: [] };
    private readonly paths: MaziPaths = ensureMaziDirs();
    private config: RuntimeConfig;

    constructor() {
        // 启动：先用本地目录权威替换一次（同步、失败不阻断），再异步做在线发现（端点真实模型名）。
        try {
            this.syncProviderModels();
        } catch (error) {
            this.logger.warn(`syncProviderModels on boot failed: ${String(error)}`);
        }
        this.config = toRuntimeConfig(loadRuntimeConfig(this.paths.home), {
            consoleEnabled: false,
        });
        // 随心聊默认工作区：workspaces.json 配置优先，缺省 $MAZI_HOME/workspace（避免落在进程 cwd 如 apps/api）。
        this.readWorkspacesState();
        this.freeChatWorkspaceValue =
            this.workspacesState.freeChatWorkspace?.trim() || join(this.paths.home, 'workspace');
        mkdirSync(this.freeChatWorkspaceValue, { recursive: true });
        void this.syncProviderModelsOnline()
            .then((result) => {
                if (result.changed) {
                    this.config = toRuntimeConfig(loadRuntimeConfig(this.paths.home), {
                        consoleEnabled: false,
                    });
                }
                for (const warning of result.warnings) this.logger.warn(`model sync: ${warning}`);
            })
            .catch((error) =>
                this.logger.warn(`online model sync on boot failed: ${String(error)}`),
            );
    }

    /** 读取 providers.json；缺失/损坏 → undefined（调用方跳过，不覆盖）。 */
    private readProvidersFile(): { providers?: Array<Record<string, unknown>> } | undefined {
        const file = this.paths.providersFile;
        if (!existsSync(file)) return undefined;
        try {
            return JSON.parse(readFileSync(file, 'utf8')) as {
                providers?: Array<Record<string, unknown>>;
            };
        } catch (error) {
            this.logger.warn(`read providers.json failed: ${String(error)}`);
            return undefined;
        }
    }

    private writeProvidersFile(parsed: { providers?: Array<Record<string, unknown>> }): void {
        writeFileSync(this.paths.providersFile, JSON.stringify(parsed, null, 2));
    }

    /**
     * 离线同步（启动兜底）：按 pi-ai 本地目录**权威替换** models 列表。
     * 未知厂商（目录无此 provider）保留原 models；厂商未发布的陈旧 id 会被移除。
     */
    syncProviderModels(): boolean {
        const parsed = this.readProvidersFile();
        if (parsed === undefined) return false;
        let changed = false;
        for (const provider of parsed.providers ?? []) {
            const vendor = driverProviderOf(provider);
            if (vendor === undefined) continue;
            const infos = builtinModelsFor(vendor);
            if (infos.length === 0) continue;
            if (
                applyModelList(
                    provider,
                    infos.map((info) => info.id),
                    infos,
                )
            )
                changed = true;
            const pricing = infos[0]?.pricing;
            if (pricing && applyCatalogPricing(provider, pricing)) changed = true;
        }
        if (changed) {
            this.writeProvidersFile(parsed);
            this.logger.log('syncProviderModels: models/pricing replaced from local catalog');
        }
        return changed;
    }

    /**
     * 在线同步：调用厂商 GET /models 发现端点真实模型名，**权威替换** models 并修正 driver.model。
     * 无 Key / 网络失败 → 回退本地目录（仍替换，移除陈旧 id）。返回 warnings 供 UI / 事件展示。
     */
    async syncProviderModelsOnline(): Promise<{ changed: boolean; warnings: string[] }> {
        const parsed = this.readProvidersFile();
        if (parsed === undefined) return { changed: false, warnings: [] };
        let changed = false;
        const warnings: string[] = [];
        for (const provider of parsed.providers ?? []) {
            const vendor = driverProviderOf(provider);
            if (vendor === undefined) continue;
            const baseUrl = driverBaseUrlOf(provider);
            const result = await discoverModels(vendor, {
                env: process.env,
                ...(baseUrl !== undefined ? { baseUrl } : {}),
            });
            if (result.warning !== undefined) {
                warnings.push(`${String(provider.id)}: ${result.warning}`);
            }
            if (result.models.length === 0) continue;
            const metadata = builtinModelsFor(vendor);
            if (applyModelList(provider, result.models, metadata)) changed = true;
            const pricing = metadata[0]?.pricing;
            if (pricing && applyCatalogPricing(provider, pricing)) changed = true;
        }
        if (changed) this.writeProvidersFile(parsed);
        this.logger.log(
            `syncProviderModelsOnline: changed=${String(changed)} warnings=${String(warnings.length)}`,
        );
        return { changed, warnings };
    }

    /**
     * 手动同步：在线发现端点真实模型 → 权威替换 → 重新加载配置 → 丢弃 runtime（下次重建）。
     * 会话执行中不重建，避免打断在跑的 run。
     */
    async syncConfig(): Promise<ReturnType<typeof configOverview>> {
        await this.syncProviderModelsOnline();
        this.config = toRuntimeConfig(loadRuntimeConfig(this.paths.home), {
            consoleEnabled: false,
        });
        if (!this.running) {
            await this.restartRuntimes();
        }
        return this.overview();
    }

    /** 丢弃并重建运行时（不重启进程）：下次 harness() 按最新配置装配。 */
    async restartRuntimes(): Promise<{ restarted: number }> {
        const stale = [this.runtime, ...this.workspaces.values()];
        this.runtime = undefined;
        this.workspaces.clear();
        this.approvalBrokers.clear();
        for (const runtime of stale) {
            if (runtime) await runtime.close();
        }
        return { restarted: stale.length };
    }

    /** 进程内重启语义：在线重同步模型 + 重建运行时；执行中不打断（restarted=0）。 */
    async restart(): Promise<ReturnType<typeof configOverview> & { restarted: number }> {
        await this.syncProviderModelsOnline();
        this.config = toRuntimeConfig(loadRuntimeConfig(this.paths.home), {
            consoleEnabled: false,
        });
        const { restarted } = this.running ? { restarted: 0 } : await this.restartRuntimes();
        return { ...this.overview(), restarted };
    }

    /**
     * 模型恢复：在线重同步后返回指定（缺省首个）provider 与其修正后的默认模型，供运行时换模重试。
     */
    async recoverModels(
        providerId?: string,
    ): Promise<{ providerId: string; modelId: string } | undefined> {
        await this.syncProviderModelsOnline();
        this.config = toRuntimeConfig(loadRuntimeConfig(this.paths.home), {
            consoleEnabled: false,
        });
        const providers = this.readProvidersFile()?.providers ?? [];
        const provider =
            (providerId !== undefined
                ? providers.find((item) => String(item.id) === providerId)
                : undefined) ?? providers[0];
        if (provider === undefined) return undefined;
        const vendor = driverProviderOf(provider);
        const modelId = driverModelOf(provider);
        if (vendor === undefined || modelId === undefined) return undefined;
        return { providerId: String(provider.id), modelId };
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
                // 随心聊使用配置的默认工作区（不再回退进程 cwd）。
                this.runtime = new HarnessRuntime(this.config, {
                    workspaceRoot: this.freeChatWorkspaceValue,
                });
                this.attachCatalog(this.runtime);
                this.attachApprovals(this.runtime);
                this.logger.debug(
                    `harness: default runtime assembled root=${this.freeChatWorkspaceValue}`,
                );
            }
            return this.runtime as HarnessRuntime;
        }
        if (!this.workspaces.has(this.workspaceRoot)) {
            const workspaceRuntime = new HarnessRuntime(this.config, {
                workspaceRoot: this.workspaceRoot,
            });
            this.attachCatalog(workspaceRuntime);
            this.attachApprovals(workspaceRuntime);
            this.workspaces.set(this.workspaceRoot, workspaceRuntime);
            this.logger.debug(`harness: workspace runtime assembled root=${this.workspaceRoot}`);
        }
        return this.workspaces.get(this.workspaceRoot) as HarnessRuntime;
    }

    /** 接入人审审批 broker：gated 调用经 UI 审批，超时 fail-closed。 */
    private attachApprovals(runtime: HarnessRuntime): void {
        const broker = new ApprovalBroker({
            emit: (event) => runtime.eventBus.emit(event),
        });
        runtime.setApprovalSeam(broker);
        this.approvalBrokers.set(runtime, broker);
    }

    /** 所有工作区待审批请求（UI 轮询 / 事件流补充）。 */
    pendingApprovals(): PendingApproval[] {
        return [...this.approvalBrokers.values()].flatMap((broker) => broker.pending());
    }

    /** 结算一条审批；找不到返回 false。 */
    settleApproval(invocationId: string, settlement: ApprovalSettlement): boolean {
        for (const broker of this.approvalBrokers.values()) {
            if (broker.settle(invocationId, settlement)) return true;
        }
        return false;
    }

    /** 目录服务异步就绪后接入运行时；就绪前的请求不落账本（best-effort，不阻断执行）。 */
    private attachCatalog(runtime: HarnessRuntime): void {
        void this.catalog()
            .then((service) => runtime.setCatalog(service))
            .catch((error) => this.logger.warn(`attachCatalog failed: ${String(error)}`));
        // 模型被厂商拒绝 → 重同步端点模型并换模重试（llm.error 自愈路径）。
        runtime.setModelRecovery(async (request) => {
            const recovered = await this.recoverModels(request.providerId);
            if (recovered !== undefined) {
                this.logger.warn(`model recovery: ${recovered.providerId} → ${recovered.modelId}`);
            }
            return recovered;
        });
    }

    private get workspacesFile(): string {
        return join(this.paths.home, 'workspaces.json');
    }

    private readWorkspacesState(): { title: string; path: string; sessionIds?: string[] }[] {
        try {
            const parsed = JSON.parse(readFileSync(this.workspacesFile, 'utf8')) as {
                projects?: { title: string; path: string; sessionIds?: string[] }[];
                freeChatWorkspace?: string;
            };
            this.workspacesState.projects = parsed.projects ?? [];
            if (typeof parsed.freeChatWorkspace === 'string') {
                this.workspacesState.freeChatWorkspace = parsed.freeChatWorkspace;
            }
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

    /** 随心聊默认工作区（未选项目时运行时使用）。 */
    get freeChatWorkspace(): string {
        return this.freeChatWorkspaceValue;
    }

    /** 设置随心聊默认工作区（缺失则创建）；持久化并重建运行时。 */
    setFreeChatWorkspace(path?: string): string {
        const next = (path ?? '').trim() || join(this.paths.home, 'workspace');
        mkdirSync(next, { recursive: true });
        this.freeChatWorkspaceValue = next;
        this.readWorkspacesState();
        this.workspacesState.freeChatWorkspace = next;
        this.writeWorkspacesState();
        if (!this.running) void this.restartRuntimes();
        this.logger.log(`setFreeChatWorkspace → ${next}`);
        return next;
    }

    /** 配置总览 */
    overview(): {
        home: string;
        providers: Array<{ id: string; models: Array<{ id: string; name?: string }> }>;
        hasProvidersFile: boolean;
        freeChatWorkspace: string;
        permissionCeiling: PermissionLevel;
    } {
        return {
            ...configOverview(),
            freeChatWorkspace: this.freeChatWorkspaceValue,
            permissionCeiling: this.config.goal?.permissionCeiling ?? 'read-only',
        };
    }

    /**
     * 系统级权限 grant（Settings → General）。写入 settings.json 并重建运行时，
     * 新会话即按新档位派生；已在跑的会话不受影响（钉版语义）。
     */
    async setPermissionCeiling(value: PermissionLevel): Promise<PermissionLevel> {
        saveRuntimeSettings({ goal: { permissionCeiling: value } }, this.paths.home);
        this.config = { ...this.config, goal: { ...this.config.goal, permissionCeiling: value } };
        await this.restartRuntimes();
        this.logger.log(`setPermissionCeiling → ${value}`);
        return value;
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
        for (const broker of this.approvalBrokers.values()) broker.cancelAll();
        this.approvalBrokers.clear();
        await this.runtime?.close();
    }
}
