import 'reflect-metadata';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { CatalogChange, PermissionLevel } from '@mazi/core';
import type {
    MaziPaths,
    PricingSchedule,
    ProviderConfig,
    ProviderModelInfo,
    ProviderModelPricing,
    RuntimeConfig,
    RuntimeSettingsFile,
    VendorPricingSource,
} from '@mazi/runtime';
import {
    ApprovalBroker,
    type ApprovalSettlement,
    apiKeyStatus,
    builtinModelsFor,
    CatalogService,
    configOverview,
    createPricingAnalyst,
    DEEPSEEK_PEAK_TIERS,
    DEEPSEEK_PRICING_SOURCE,
    DEEPSEEK_PRICING_VERSION,
    deepseekTierOf,
    discoverModels,
    ensureMaziDirs,
    FileCatalogStore,
    HarnessRuntime,
    htmlToText,
    loadRuntimeConfig,
    loadRuntimeSettings,
    loadSecrets,
    observedCatalogFromProviderConfigs,
    type ParsedModelPricing,
    type PendingApproval,
    type PricingPageAnalyst,
    parseDeepseekPricingPage,
    peakMultiplierOf,
    resolveScopedPermission,
    resolveVendorPricingSource,
    type SecretsFile,
    saveProviderApiKey,
    saveRuntimeSettings,
    toRuntimeConfig,
    withProviderSecrets,
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
    const currency = (pricing.currency ?? 'USD') as 'USD' | 'CNY';
    // 官网抓取的官方人民币价优先：目录价（USD）不得覆盖已落地的官方价，
    // 否则手动/周期性模型同步会把官方价回退成 pi-ai 目录价。
    if (
        current.currency === 'CNY' &&
        current.version === DEEPSEEK_PRICING_VERSION &&
        currency !== 'CNY'
    ) {
        return false;
    }
    const next = {
        ...current,
        currency,
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
        // 人民币（DeepSeek 官方价）挂空闲时段半价 tiers（北京时间周中 9-12/14-18 为高峰）。
        tiers:
            current.tiers && current.tiers.length > 0
                ? current.tiers
                : currency === 'CNY'
                  ? DEEPSEEK_PEAK_TIERS
                  : [],
        effectiveAt: current.effectiveAt ?? 0,
        version: currency === 'CNY' ? DEEPSEEK_PRICING_VERSION : (current.version ?? 'catalog'),
    };
    if (JSON.stringify(next) === JSON.stringify(current)) {
        return false;
    }
    provider.pricing = next;
    return true;
}

/**
 * 由官网解析结果构造 CNY 价目表（空闲时段为 base，高峰时段为 tiers）。
 * rates 未变时沿用 previous.effectiveAt，避免每次同步都刷新时间戳（触发无谓重建）。
 */
function buildCnySchedule(entry: ParsedModelPricing, previous?: PricingSchedule): PricingSchedule {
    const base = {
        inputPerMTok: entry.idle.inputPerMTok ?? 0,
        outputPerMTok: entry.idle.outputPerMTok ?? 0,
        cacheReadPerMTok: entry.idle.cacheReadPerMTok ?? 0,
    };
    const tiers = DEEPSEEK_PEAK_TIERS.map((tier) => ({
        ...tier,
        multiplier: peakMultiplierOf(entry) ?? tier.multiplier,
    }));
    const unchanged =
        previous !== undefined &&
        previous.currency === 'CNY' &&
        previous.version === DEEPSEEK_PRICING_VERSION &&
        JSON.stringify(previous.base) === JSON.stringify(base) &&
        JSON.stringify(previous.tiers) === JSON.stringify(tiers);
    return {
        currency: 'CNY',
        base,
        tiers,
        effectiveAt: unchanged ? (previous.effectiveAt ?? Date.now()) : Date.now(),
        version: DEEPSEEK_PRICING_VERSION,
    };
}

/**
 * provider 是否已落官方人民币价目（version = DEEPSEEK_PRICING_VERSION）。
 * 官网是模型清单与价格的权威：已落官方价后，pi-ai 目录（可能含已下线 id）不得再覆盖。
 */
function hasOfficialPricing(provider: Record<string, unknown>): boolean {
    const pricing = provider.pricing as { currency?: unknown; version?: unknown } | undefined;
    return pricing?.currency === 'CNY' && pricing?.version === DEEPSEEK_PRICING_VERSION;
}

/** provider 条目的厂商（vendor）：显式 vendor → driver.provider。 */
function vendorKeyOf(provider: { vendor?: unknown; driver?: { provider?: unknown } }): string {
    if (typeof provider.vendor === 'string' && provider.vendor.trim().length > 0) {
        return provider.vendor.trim();
    }
    if (typeof provider.driver?.provider === 'string') return provider.driver.provider;
    return '';
}

/** 各厂商内置默认价目源（可被设置覆盖）。 */
const DEFAULT_PRICING_SOURCES: Record<string, string> = {
    deepseek: DEEPSEEK_PRICING_SOURCE,
};

/**
 * 生效价目源表：以配置里出现的 vendor（含默认 deepseek）为键，
 * 取值顺序 `pricing.vendors[vendor].sourceUrl` → 旧 `pricing.sourceUrl`(deepseek) → 内置默认。
 */
function resolvePricingSources(
    settings: RuntimeSettingsFile,
    providers: ProviderConfig[],
): Record<string, string> {
    const vendors = new Set<string>(Object.keys(DEFAULT_PRICING_SOURCES));
    for (const provider of providers) {
        const vendor = vendorKeyOf(provider);
        if (vendor.length > 0) vendors.add(vendor);
    }
    const out: Record<string, string> = {};
    for (const vendor of vendors) {
        out[vendor] = resolveVendorPricingSource(settings, vendor, DEFAULT_PRICING_SOURCES[vendor]);
    }
    return out;
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
    /** 作用域权限覆盖：`workspace:<path>` / `conversation:<id>`（settings.json 持久化）。 */
    private permissions: Record<string, string> = {};
    /** 价格/模型定时校准（默认 5 分钟；MAZI_PRICE_SYNC_MS 可覆盖）。 */
    private priceSyncTimer?: ReturnType<typeof setInterval>;
    /** 各厂商（vendor）官方价目源：vendor → URL（设置可配置；抓取→解析→写 providers.json）。 */
    private pricingSources: Record<string, string> = {};
    /** 价目页 Agent 解析器（确定性解析失败时的兜底；宿主/测试可覆盖）。 */
    private pricingAnalystOverride?: PricingPageAnalyst;
    /** 最近一次官网抓取给出模型清单的 vendor 集合（这些 vendor 跳过单独的端点模型发现）。 */
    private officialModelListVendors = new Set<string>();
    /** 价目页抓取实现（测试/宿主可覆盖；缺省用全局 fetch）。 */
    private pricingFetch?: typeof fetch;
    /** 供应商 API Key（secrets.json；注入 RuntimeConfig.driver.apiKey，不回显明文）。 */
    private secrets: SecretsFile = {};
    private readonly paths: MaziPaths = ensureMaziDirs();
    private config: RuntimeConfig;

    constructor() {
        // 启动：先用本地目录权威替换一次（同步、失败不阻断），再异步做在线发现（端点真实模型名）。
        try {
            this.syncProviderModels();
        } catch (error) {
            this.logger.warn(`syncProviderModels on boot failed: ${String(error)}`);
        }
        this.secrets = loadSecrets(this.paths.home);
        this.config = withProviderSecrets(
            toRuntimeConfig(loadRuntimeConfig(this.paths.home), { consoleEnabled: false }),
            this.secrets,
        );
        const settings = loadRuntimeSettings(this.paths.home);
        this.permissions = settings.permissions ?? {};
        // 价目源按 vendor 生效（deepseek 默认内置地址；其余 vendor 由设置提供）。
        this.pricingSources = resolvePricingSources(settings, this.config.providers);
        // 随心聊默认工作区：workspaces.json 配置优先，缺省 $MAZI_HOME/workspace（避免落在进程 cwd 如 apps/api）。
        this.readWorkspacesState();
        this.freeChatWorkspaceValue =
            this.workspacesState.freeChatWorkspace?.trim() || join(this.paths.home, 'workspace');
        mkdirSync(this.freeChatWorkspaceValue, { recursive: true });
        // 启动即做一次在线校准：官网价目（可能内含权威模型清单）→ 按需端点模型发现。
        void this.syncModelsAndPricing('boot').catch((error) =>
            this.logger.warn(`online sync on boot failed: ${String(error)}`),
        );
        // 价格与模型目录定时校准（默认 5 分钟；MAZI_PRICE_SYNC_MS 可覆盖）。
        const priceSyncMs = Number(process.env.MAZI_PRICE_SYNC_MS ?? 5 * 60 * 1000);
        if (Number.isFinite(priceSyncMs) && priceSyncMs > 0) {
            this.priceSyncTimer = setInterval(() => {
                void this.syncModelsAndPricing('periodic').catch((error) =>
                    this.logger.warn(`periodic model/price sync failed: ${String(error)}`),
                );
            }, priceSyncMs);
            this.priceSyncTimer.unref?.();
        }
    }

    /**
     * 启动/周期在线校准：先抓各 vendor 官网价目页（可能同时给出权威模型清单），再按需做端点模型发现。
     * 官网给出清单的 vendor → 跳过其端点发现；价格由官网价覆盖（目录价不反向覆盖）。
     */
    private async syncModelsAndPricing(trigger: 'boot' | 'periodic'): Promise<void> {
        const pricing = await this.syncOfficialPricing();
        if (pricing.error) this.logger.warn(`official pricing sync: ${pricing.error}`);
        this.officialModelListVendors = new Set(
            Object.entries(pricing.vendors)
                .filter(([, result]) => (result.modelIds ?? []).length > 0)
                .map(([vendor]) => vendor),
        );
        const models = await this.syncProviderModelsOnline();
        if (models.changed && !this.running) {
            this.reloadConfig();
        }
        for (const warning of models.warnings) this.logger.warn(`model sync: ${warning}`);
        if (trigger === 'periodic' && models.changed && !this.running) {
            await this.restartRuntimes();
            this.logger.log('periodic model/price sync: config + runtimes refreshed');
        }
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
            // 官网价目已落地 → 模型清单以官网为准，不再用 pi-ai 目录覆盖（目录含已下线 id）。
            if (hasOfficialPricing(provider)) continue;
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
            // 该 vendor 的官网价目页已给出权威模型清单（本进程或已落盘）→ 跳过端点发现。
            if (
                this.officialModelListVendors.has(vendorKeyOf(provider)) ||
                hasOfficialPricing(provider)
            ) {
                this.logger.log(
                    `skip endpoint model discovery for ${String(provider.id)}: official pricing page provided the model list`,
                );
                continue;
            }
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
        this.reloadConfig();
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
        this.reloadConfig();
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
        this.reloadConfig();
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
        permissions: Record<string, string>;
        /** 各 vendor 生效的官方价目源。 */
        pricingSources: Record<string, string>;
        /** 各 vendor 最近同步状态（时间 / 错误 / 模型档数）。 */
        pricingSyncState: Record<string, VendorPricingSource>;
        /** @deprecated 兼容旧前端：默认厂商（deepseek）的价目源。 */
        pricingSourceUrl: string;
        /** provider id → 已配置 API Key 的遮蔽形态（中间隐私；不回显明文）。 */
        apiKeyMasked: Record<string, string>;
    } {
        const settings = loadRuntimeSettings(this.paths.home);
        return {
            ...configOverview(),
            freeChatWorkspace: this.freeChatWorkspaceValue,
            permissionCeiling: this.config.goal?.permissionCeiling ?? 'read-only',
            permissions: this.permissions,
            pricingSources: this.pricingSources,
            pricingSyncState: settings.pricing?.vendors ?? {},
            pricingSourceUrl: this.pricingSources.deepseek ?? '',
            apiKeyMasked: apiKeyStatus(this.secrets),
        };
    }

    /** 重新从磁盘加载 RuntimeConfig 并注入 secrets（API Key）。 */
    private reloadConfig(): void {
        this.config = withProviderSecrets(
            toRuntimeConfig(loadRuntimeConfig(this.paths.home), { consoleEnabled: false }),
            this.secrets,
        );
    }

    /**
     * 设置/清除某 provider 的 API Key（secrets.json，0600；空 = 清除）。
     * 立即重建 config 与运行时，使后续会话生效。
     */
    async setApiKey(providerId: string, apiKey: string): Promise<void> {
        const id = providerId.trim();
        if (id.length === 0) return;
        this.secrets = saveProviderApiKey(id, apiKey, this.paths.home);
        this.reloadConfig();
        if (!this.running) await this.restartRuntimes();
        this.logger.log(`setApiKey[${id}] → ${apiKey.trim().length > 0 ? '(set)' : '(cleared)'}`);
    }

    /** 设置某厂商（vendor）的官方价目源（settings.json 持久化）；返回最新价目源表。 */
    setPricingSource(vendor: string, url: string): Record<string, string> {
        const key = vendor.trim() || 'deepseek';
        const next = url.trim();
        this.pricingSources = { ...this.pricingSources, [key]: next };
        saveRuntimeSettings(
            { pricing: { vendors: { [key]: { sourceUrl: next } } } },
            this.paths.home,
        );
        this.logger.log(`setPricingSource[${key}] → ${next || '(disabled)'}`);
        return this.pricingSources;
    }

    /** 注入/清除价目页 Agent 解析器（测试或宿主自定义；缺省按配置构造）。 */
    setPricingAnalyst(analyst?: PricingPageAnalyst): void {
        this.pricingAnalystOverride = analyst;
    }

    /** 注入/清除价目页抓取实现（测试注入 fake；缺省用全局 fetch）。 */
    setPricingFetch(impl?: typeof fetch): void {
        this.pricingFetch = impl;
    }

    /**
     * 抓取各 vendor 官网价目页 → 解析 → 写 providers.json（覆盖 pi-ai 目录价）。
     * 单厂商失败只告警、不覆盖该厂商既有配置（fail-safe）。缺省处理全部已配置厂商。
     */
    async syncOfficialPricing(vendor?: string): Promise<{
        updated: boolean;
        models: number;
        modelIds?: string[];
        error?: string;
        vendors: Record<
            string,
            { updated: boolean; models: number; modelIds?: string[]; error?: string }
        >;
    }> {
        const targets =
            vendor !== undefined
                ? [vendor]
                : Object.keys(this.pricingSources).filter(
                      (key) => (this.pricingSources[key] ?? '').trim().length > 0,
                  );
        const vendors: Record<
            string,
            { updated: boolean; models: number; modelIds?: string[]; error?: string }
        > = {};
        let anyUpdated = false;
        let totalModels = 0;
        const modelIds: string[] = [];
        let firstError: string | undefined;
        for (const key of targets) {
            const result = await this.syncVendorPricing(key);
            vendors[key] = result;
            if (result.updated) anyUpdated = true;
            totalModels += result.models;
            if (result.modelIds) modelIds.push(...result.modelIds);
            if (result.error !== undefined && firstError === undefined) {
                firstError = result.error;
            }
        }
        return {
            updated: anyUpdated,
            models: totalModels,
            ...(modelIds.length > 0 ? { modelIds } : {}),
            ...(firstError !== undefined ? { error: firstError } : {}),
            vendors,
        };
    }

    /** 持久化某 vendor 的同步状态（成功清 lastError，失败清上次成功时间）。 */
    private recordPricingState(vendor: string, state: VendorPricingSource): void {
        saveRuntimeSettings({ pricing: { vendors: { [vendor]: state } } }, this.paths.home);
    }

    /** 单 vendor：抓取 → 解析（确定性优先，Agent 兜底）→ 写该 vendor 的 providers 条目。 */
    private async syncVendorPricing(vendor: string): Promise<{
        updated: boolean;
        models: number;
        modelIds?: string[];
        error?: string;
    }> {
        const url = (this.pricingSources[vendor] ?? '').trim();
        if (url.length === 0) return { updated: false, models: 0 };
        // 测试环境禁止真实网络请求（保持 hermetic）；显式注入抓取实现时除外。
        if (process.env.VITEST && this.pricingFetch === undefined) {
            return { updated: false, models: 0 };
        }
        const doFetch = this.pricingFetch ?? fetch;
        try {
            const res = await doFetch(url);
            if (!res.ok) {
                this.recordPricingState(vendor, {
                    lastError: `HTTP ${res.status}`,
                    lastSyncedAt: undefined,
                    models: undefined,
                });
                return { updated: false, models: 0, error: `HTTP ${res.status}` };
            }
            const html = await res.text();
            // 已知厂商走确定性解析；其余厂商交给 Agent。
            let parsed = vendor === 'deepseek' ? parseDeepseekPricingPage(html, url) : null;
            if (!parsed) {
                const analyst =
                    this.pricingAnalystOverride ?? createPricingAnalyst(this.config, { vendor });
                if (analyst) {
                    try {
                        parsed = await analyst({ url, text: htmlToText(html) });
                    } catch (error) {
                        this.logger.warn(
                            `pricing page agent analysis failed[${vendor}]: ${String(error)}`,
                        );
                    }
                }
            }
            if (!parsed) {
                this.recordPricingState(vendor, { lastError: 'parse-failed' });
                return { updated: false, models: 0, error: 'parse-failed' };
            }
            // 过滤页面标注为「已下线」的旧模型名（防目录/解析把陈旧 id 写进来）。
            const deprecated = new Set(parsed.deprecatedModels ?? []);
            const vendorModelIds = parsed.models
                .map((model) => model.id)
                .filter((id) => !deprecated.has(id));
            const file = loadRuntimeConfig(this.paths.home);
            let changed = false;
            for (const provider of file.providers) {
                const record = provider as unknown as Record<string, unknown>;
                if (vendorKeyOf(record) !== vendor) continue;
                // 官网同时给出模型清单 → 以官网为权威替换（保留同 id 的既有元数据）。
                if (
                    vendorModelIds.length > 0 &&
                    applyModelList(record, vendorModelIds, builtinModelsFor(vendor))
                ) {
                    changed = true;
                }
                // 逐模型写入各自价目（如 flash/pro 单价不同）+ 页面标注的上下文/输出窗口。
                for (const model of provider.models ?? []) {
                    const entry = parsed.models.find((m) => m.tier === deepseekTierOf(model.id));
                    if (entry === undefined) continue;
                    if (
                        parsed.contextWindowTokens !== undefined &&
                        model.contextWindow !== parsed.contextWindowTokens
                    ) {
                        model.contextWindow = parsed.contextWindowTokens;
                        changed = true;
                    }
                    if (
                        parsed.maxOutputTokens !== undefined &&
                        model.maxTokens !== parsed.maxOutputTokens
                    ) {
                        model.maxTokens = parsed.maxOutputTokens;
                        changed = true;
                    }
                    const next = buildCnySchedule(entry, model.pricing);
                    if (JSON.stringify(next) !== JSON.stringify(model.pricing)) {
                        model.pricing = next;
                        changed = true;
                    }
                }
                // provider 级 pricing = 默认模型（driver.model）的价目。
                const defaultEntry =
                    parsed.models.find(
                        (m) => m.tier === deepseekTierOf(driverModelOf(record) ?? ''),
                    ) ?? parsed.models[0];
                if (defaultEntry !== undefined) {
                    const next = buildCnySchedule(defaultEntry, provider.pricing);
                    if (JSON.stringify(next) !== JSON.stringify(provider.pricing)) {
                        provider.pricing = next;
                        changed = true;
                    }
                }
            }
            this.recordPricingState(vendor, {
                lastSyncedAt: Date.now(),
                models: parsed.models.length,
                lastError: undefined,
            });
            if (!changed) {
                return { updated: false, models: parsed.models.length, modelIds: vendorModelIds };
            }
            writeFileSync(
                this.paths.providersFile,
                JSON.stringify({ providers: file.providers }, null, 2),
            );
            this.reloadConfig();
            if (!this.running) await this.restartRuntimes();
            this.logger.log(
                `syncOfficialPricing[${vendor}]: updated ${parsed.models.length} model tiers from ${url}`,
            );
            return { updated: true, models: parsed.models.length, modelIds: vendorModelIds };
        } catch (error) {
            this.recordPricingState(vendor, { lastError: String(error) });
            return { updated: false, models: 0, error: String(error) };
        }
    }

    /** 解析某工作区/会话的生效权限：会话覆盖 → 工作区覆盖 → 系统默认。 */
    resolvePermission(workspace?: string, conversationId?: string): PermissionLevel {
        return resolveScopedPermission(this.permissions, {
            ...(workspace !== undefined ? { workspace } : {}),
            ...(conversationId !== undefined ? { conversationId } : {}),
            fallback: this.config.goal?.permissionCeiling ?? 'read-only',
        });
    }

    /** 写入某工作区/会话的独立权限覆盖；不影响其他工作区/会话。 */
    setScopedPermission(
        scope: 'workspace' | 'conversation',
        key: string,
        value: PermissionLevel,
    ): void {
        const mapKey = `${scope}:${key}`;
        this.permissions = { ...this.permissions, [mapKey]: value };
        saveRuntimeSettings({ permissions: { [mapKey]: value } }, this.paths.home);
        this.logger.log(`setScopedPermission ${mapKey} → ${value}`);
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
        if (this.priceSyncTimer) clearInterval(this.priceSyncTimer);
        for (const broker of this.approvalBrokers.values()) broker.cancelAll();
        this.approvalBrokers.clear();
        await this.runtime?.close();
    }
}
