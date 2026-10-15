/**
 * capabilities/runtime.ts —— 技能挂载状态与工具面（docs/能力包规范.md §7.2 / §9）。
 *
 * 挂载 = **用户级开关**（持久化在 `$MAZI_HOME/skills.json`），不是 Goal 内的临时状态：
 * 已挂载包的工具并入 Goal 执行工具面（与 CLI builtin 并列进入同一 RuntimeToolGateway），
 * 卸载即失权（工具立刻消失、实现缓存丢弃），记忆 append-only 保留。
 * `capability.activated/deactivated` 由 HarnessRuntime 在**运行边界**发出。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
    type HarnessEvent,
    type PermissionLevel,
    SKILL_ID_ATTRIBUTE,
    type SkillHandlerContext,
    type SkillIntents,
    type SkillMemoryAccess,
    type SkillToolDeclaration,
    type SkillToolHandler,
    type SkillValidator,
    type SkillValidatorVerdict,
} from '@mazi/core';
import type { ToolCallResult, ToolConfig } from '../config.js';
import { newHarnessEvent } from '../events/event-bus.js';
import { SkillMemoryNamespace, SkillMemoryRegistry } from './memory.js';
import { clampPermissionLevel } from './permission.js';
import type { CapabilityRegistry, SkillSnapshot } from './registry.js';
import type { SkillModuleLoader, SkillRootScope } from './source.js';
import { renderSkillTemplate } from './template.js';

/** 挂载状态持久化端口。 */
export interface SkillMountStore {
    read(): Promise<readonly string[]>;
    write(mounted: readonly string[]): Promise<void>;
}

/** 文件实现：`$MAZI_HOME/skills.json`（`{ "mounted": ["id"] }`）。 */
export class FileSkillMountStore implements SkillMountStore {
    constructor(private readonly file: string) {}

    async read(): Promise<readonly string[]> {
        if (!existsSync(this.file)) return [];
        try {
            const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { mounted?: unknown };
            if (!Array.isArray(parsed.mounted)) return [];
            return parsed.mounted.filter((id): id is string => typeof id === 'string');
        } catch {
            return [];
        }
    }

    async write(mounted: readonly string[]): Promise<void> {
        mkdirSync(dirname(this.file), { recursive: true });
        writeFileSync(this.file, JSON.stringify({ mounted: [...mounted].sort() }, null, 2), 'utf8');
    }
}

/** 进程内实现（测试 / 无状态宿主）。 */
export class MemorySkillMountStore implements SkillMountStore {
    private mounted: readonly string[] = [];

    constructor(initial: readonly string[] = []) {
        this.mounted = [...initial];
    }

    async read(): Promise<readonly string[]> {
        return [...this.mounted];
    }

    async write(mounted: readonly string[]): Promise<void> {
        this.mounted = [...mounted];
    }
}

/** 列表视图（UI 数据面）。 */
export interface SkillView {
    id: string;
    name: string;
    version: string;
    description: string;
    scope: SkillRootScope;
    dir: string;
    permissionCeiling: PermissionLevel;
    intents: SkillIntents;
    toolNames: readonly string[];
    mounted: boolean;
    mountedAt?: number;
}

/** 详情视图：manifest 全量 + 工具 / 记忆 schema / 模板 / 校验器 / 事件。 */
export interface SkillDetailView extends SkillView {
    tools: readonly SkillToolDeclaration[];
    templates: readonly string[];
    validators: readonly string[];
    memory: {
        collections: SkillSnapshot['manifest']['memory']['collections'];
        schemas: Record<string, Record<string, unknown>>;
    };
    events: SkillSnapshot['manifest']['events'];
    privacy?: { note?: string };
}

/** 工具调用所属的运行上下文（用于校验失败落 event 流）。 */
export interface SkillRunContext {
    rootGoalId: string;
    goalId?: string;
    taskId?: string;
    /** 运行的事件总线出口（HarnessRuntime 注入）。 */
    emit?: (event: HarnessEvent) => void;
}

/** 已挂载技能包对外提供的工具面（HarnessRuntime 消费）。 */
export interface SkillProvider {
    toolConfigs(context: SkillRunContext): readonly ToolConfig[];
    effectivePermissionLevel(goalLevel: PermissionLevel): PermissionLevel;
    mounted(): readonly string[];
}

export interface SkillAuditEntry {
    action: 'mount' | 'unmount';
    skillId: string;
    at: number;
}

export interface SkillRuntimeOptions {
    registry: CapabilityRegistry;
    state: SkillMountStore;
    loadModule?: SkillModuleLoader;
    memory?: SkillMemoryRegistry;
    now?: () => number;
    /** 挂载/卸载审计回调（宿主接行为流 / 日志）。 */
    onAudit?: (entry: SkillAuditEntry) => void;
}

interface LoadedSkillModules {
    handlers: Map<string, SkillToolHandler>;
    validators: Map<string, SkillValidator>;
    events?: (event: HarnessEvent, context: { skillId: string }) => unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHandlerFailure(value: unknown): value is { ok: false; reason?: string } {
    return isRecord(value) && value.ok === false;
}

function stringifyHandlerResult(value: unknown): string {
    if (value === undefined || value === null) return '';
    return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * 技能运行时：发现结果的挂载状态 + 工具物化 + 天花板收敛。
 * 工具物化是同步的（Goal 装配路径要求），因此挂载时预加载 handler/validator 模块。
 */
export class SkillRuntime implements SkillProvider {
    readonly registry: CapabilityRegistry;
    private readonly state: SkillMountStore;
    private readonly loadModule: SkillModuleLoader;
    private readonly memoryRegistry: SkillMemoryRegistry;
    private readonly now: () => number;
    private readonly onAudit?: (entry: SkillAuditEntry) => void;
    private readonly mountedIds = new Set<string>();
    private readonly mountedAt = new Map<string, number>();
    private readonly modules = new Map<string, LoadedSkillModules>();
    private readonly loading = new Map<string, Promise<void>>();

    constructor(options: SkillRuntimeOptions) {
        this.registry = options.registry;
        this.state = options.state;
        this.loadModule = options.loadModule ?? options.registry.loadModule;
        this.memoryRegistry = options.memory ?? new SkillMemoryRegistry();
        this.now = options.now ?? Date.now;
        if (options.onAudit !== undefined) this.onAudit = options.onAudit;
    }

    /** 读取挂载状态并预加载已挂载包的实现模块（进程启动 / 重扫后调用）。 */
    async init(): Promise<void> {
        const ids = await this.state.read();
        this.mountedIds.clear();
        this.mountedAt.clear();
        for (const id of ids) {
            const snapshot = this.registry.get(id);
            if (snapshot === undefined) continue;
            await this.ensureLoaded(snapshot);
            this.mountedIds.add(id);
            this.mountedAt.set(id, this.now());
        }
    }

    /** 列表（发现 + 挂载状态合并）。 */
    list(): readonly SkillView[] {
        return this.registry.list().map((snapshot) => this.viewOf(snapshot));
    }

    detail(id: string): SkillDetailView | undefined {
        const snapshot = this.registry.get(id);
        if (snapshot === undefined) return undefined;
        const manifest = snapshot.manifest;
        return {
            ...this.viewOf(snapshot),
            tools: snapshot.tools,
            templates: [...snapshot.templates.keys()],
            validators: [...snapshot.validators.keys()],
            memory: {
                collections: manifest.memory.collections,
                schemas: Object.fromEntries(snapshot.memorySchemas),
            },
            events: manifest.events,
            ...(manifest.privacy !== undefined ? { privacy: manifest.privacy } : {}),
        };
    }

    errors(): ReturnType<CapabilityRegistry['errors']> {
        return this.registry.errors();
    }

    shadowed(): ReturnType<CapabilityRegistry['shadowed']> {
        return this.registry.shadowed();
    }

    mounted(): readonly string[] {
        return [...this.mountedIds].sort();
    }

    isMounted(id: string): boolean {
        return this.mountedIds.has(id);
    }

    /** 挂载（幂等）；未发现/未通过校验的包拒绝挂载，且不落状态。 */
    async mount(id: string): Promise<SkillView> {
        const snapshot = this.registry.get(id);
        if (snapshot === undefined) throw new Error('技能不存在或未通过校验：' + id);
        if (!this.mountedIds.has(id)) {
            await this.ensureLoaded(snapshot);
            this.mountedIds.add(id);
            const at = this.now();
            this.mountedAt.set(id, at);
            await this.state.write(this.mounted());
            this.onAudit?.({ action: 'mount', skillId: id, at });
        }
        return this.viewOf(snapshot);
    }

    /** 卸载（幂等）：工具面立即消失、实现缓存丢弃；记忆 append-only 保留。 */
    async unmount(id: string): Promise<boolean> {
        if (!this.mountedIds.has(id)) return false;
        this.mountedIds.delete(id);
        this.mountedAt.delete(id);
        this.modules.delete(id);
        const at = this.now();
        await this.state.write(this.mounted());
        this.onAudit?.({ action: 'unmount', skillId: id, at });
        return true;
    }

    /** 已挂载包的工具目录（Goal 执行装配消费；同步、无 IO）。 */
    toolConfigs(context: SkillRunContext): readonly ToolConfig[] {
        const configs: ToolConfig[] = [];
        for (const snapshot of this.registry.list()) {
            if (!this.mountedIds.has(snapshot.manifest.id)) continue;
            for (const tool of snapshot.tools) {
                configs.push({
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                    minPermission: tool.minPermission,
                    sideEffects: [...tool.sideEffects],
                    ...(tool.irreversible === true ? { irreversible: true } : {}),
                    impl: async (args) => this.invokeTool(snapshot, tool.name, args, context),
                });
            }
        }
        return configs;
    }

    /** 生效档位：min(goal, 各已挂载包 permissionCeiling)（§9.1）。 */
    effectivePermissionLevel(goalLevel: PermissionLevel): PermissionLevel {
        let level = goalLevel;
        for (const id of this.mountedIds) {
            const snapshot = this.registry.get(id);
            if (snapshot !== undefined) {
                level = clampPermissionLevel(snapshot.manifest.permissionCeiling, level);
            }
        }
        return level;
    }

    /** 本包记忆命名空间（宿主/测试按敏感度策略读写；secret 恒不可读回）。 */
    memoryOf(id: string): SkillMemoryAccess | undefined {
        const snapshot = this.registry.get(id);
        if (snapshot === undefined) return undefined;
        return new SkillMemoryNamespace(
            this.memoryRegistry,
            id,
            snapshot.manifest.memory.collections,
        );
    }

    /** 渲染某包模板（未发现 / 未声明 → 抛错，避免静默拿到空提示）。 */
    renderTemplate(
        id: string,
        name: string,
        variables: Readonly<Record<string, unknown>> = {},
    ): string {
        const snapshot = this.registry.get(id);
        if (snapshot === undefined) throw new Error('技能不存在或未通过校验：' + id);
        const template = snapshot.templates.get(name);
        if (template === undefined) throw new Error('技能 ' + id + ' 未声明模板：' + name);
        return renderSkillTemplate(template, variables);
    }

    /** 可注入 LLM 上下文的记忆（仅 normal 集合；sensitive/secret 不注入，§6.2/CP-9）。 */
    async contextMemory(id: string): Promise<Record<string, readonly Record<string, unknown>[]>> {
        const snapshot = this.registry.get(id);
        const namespace = this.memoryOf(id);
        if (snapshot === undefined || namespace === undefined) return {};
        const injected: Record<string, readonly Record<string, unknown>[]> = {};
        for (const collection of snapshot.manifest.memory.collections) {
            if ((collection.sensitivity ?? 'normal') !== 'normal') continue;
            injected[collection.name] = await namespace.list(collection.name);
        }
        return injected;
    }

    private viewOf(snapshot: SkillSnapshot): SkillView {
        const manifest = snapshot.manifest;
        const mountedAt = this.mountedAt.get(manifest.id);
        return {
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            description: manifest.description,
            scope: snapshot.scope,
            dir: snapshot.dir,
            permissionCeiling: manifest.permissionCeiling,
            intents: manifest.intents,
            toolNames: snapshot.tools.map((tool) => tool.name),
            mounted: this.mountedIds.has(manifest.id),
            ...(mountedAt !== undefined ? { mountedAt } : {}),
        };
    }

    private ensureLoaded(snapshot: SkillSnapshot): Promise<void> {
        const id = snapshot.manifest.id;
        if (this.modules.has(id)) return Promise.resolve();
        const pending = this.loading.get(id);
        if (pending !== undefined) return pending;
        const loading = this.loadModules(snapshot)
            .then((loaded) => {
                this.modules.set(id, loaded);
            })
            .finally(() => {
                this.loading.delete(id);
            });
        this.loading.set(id, loading);
        return loading;
    }

    private async loadModules(snapshot: SkillSnapshot): Promise<LoadedSkillModules> {
        const skillId = snapshot.manifest.id;
        const handlers = new Map<string, SkillToolHandler>();
        for (const tool of snapshot.tools) {
            const loaded = await this.loadModule({
                skillId,
                skillDir: snapshot.dir,
                module: tool.handler.module,
                ...(tool.handler.export !== undefined ? { export: tool.handler.export } : {}),
            });
            if (typeof loaded !== 'function') {
                throw new Error(
                    '技能 ' + skillId + ' 的工具 ' + tool.name + ' 未解析到 handler 函数',
                );
            }
            handlers.set(tool.name, loaded as SkillToolHandler);
        }
        const validators = new Map<string, SkillValidator>();
        for (const name of snapshot.manifest.validators) {
            const module = snapshot.validators.get(name);
            if (module === undefined) continue;
            const loaded = await this.loadModule({
                skillId,
                skillDir: snapshot.dir,
                module,
                export: 'default',
            });
            if (typeof loaded === 'function') validators.set(name, loaded as SkillValidator);
        }
        let events: LoadedSkillModules['events'];
        if (snapshot.eventsModule !== undefined) {
            const loaded = await this.loadModule({
                skillId,
                skillDir: snapshot.dir,
                module: snapshot.eventsModule,
                export: 'handleSkillEvent',
            });
            if (typeof loaded === 'function') {
                events = loaded as (event: HarnessEvent, context: { skillId: string }) => unknown;
            }
        }
        return { handlers, validators, ...(events !== undefined ? { events } : {}) };
    }

    private async invokeTool(
        snapshot: SkillSnapshot,
        toolName: string,
        args: Record<string, unknown>,
        context: SkillRunContext,
    ): Promise<ToolCallResult> {
        const skillId = snapshot.manifest.id;
        const loaded = this.modules.get(skillId);
        const verdict = this.runValidators(snapshot, loaded, toolName, args);
        if (!verdict.ok) {
            const reason = verdict.reason ?? '校验失败';
            this.emitValidationFailure(snapshot, toolName, reason, context);
            return { ok: false, error: reason };
        }
        const handler = loaded?.handlers.get(toolName);
        if (handler === undefined) return { ok: false, error: '工具 handler 未加载：' + toolName };
        const context2: SkillHandlerContext = {
            skillId,
            tool: toolName,
            memory: new SkillMemoryNamespace(
                this.memoryRegistry,
                skillId,
                snapshot.manifest.memory.collections,
            ),
        };
        try {
            const result = await handler(args, context2);
            if (isHandlerFailure(result)) {
                return { ok: false, error: result.reason ?? '技能工具失败：' + toolName };
            }
            return { ok: true, content: stringifyHandlerResult(result) };
        } catch (error) {
            return { ok: false, error: String(error) };
        }
    }

    private runValidators(
        snapshot: SkillSnapshot,
        loaded: LoadedSkillModules | undefined,
        toolName: string,
        args: Record<string, unknown>,
    ): SkillValidatorVerdict {
        const declared = snapshot.tools.find((tool) => tool.name === toolName);
        for (const name of declared?.validators ?? []) {
            const validator = loaded?.validators.get(name);
            if (validator === undefined) continue;
            try {
                const verdict = validator({ skillId: snapshot.manifest.id, tool: toolName, args });
                if (!verdict.ok) return verdict;
            } catch (error) {
                return { ok: false, reason: '校验器异常：' + String(error) };
            }
        }
        return { ok: true };
    }

    private emitValidationFailure(
        snapshot: SkillSnapshot,
        toolName: string,
        reason: string,
        context: SkillRunContext,
    ): void {
        if (context.emit === undefined) return;
        context.emit(
            newHarnessEvent({
                type: 'capability.validation.failed',
                rootGoalId: context.rootGoalId,
                ...(context.goalId !== undefined ? { goalId: context.goalId } : {}),
                ...(context.taskId !== undefined ? { taskId: context.taskId } : {}),
                attributes: {
                    [SKILL_ID_ATTRIBUTE]: snapshot.manifest.id,
                    'harness.level': 'warn',
                    tool: toolName,
                    reason,
                },
                payload: { skillId: snapshot.manifest.id, tool: toolName, reason },
            }),
        );
    }
}
