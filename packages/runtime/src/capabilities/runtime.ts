/**
 * capabilities/runtime.ts —— Skill 挂载状态与运行期目录注入（docs/能力包规范.md §5）。
 *
 * 挂载 = 用户级开关（$MAZI_HOME/skills.json）：挂载后该 Skill 的 name/description/path
 * 进入每次运行的系统提示（渐进披露 L1 目录）；模型判断相关后用**已有工具**读 SKILL.md
 * 正文（L2）与随包文件（L3）。Skill 不改变工具面、不授予任何权限。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SkillDocument, SkillFrontmatter } from '@mazi/core';
import type { SkillRegistry, SkillSnapshot } from './registry.js';
import type { SkillRootScope } from './source.js';

/** 挂载状态持久化端口。 */
export interface SkillMountStore {
    read(): Promise<readonly string[]>;
    write(mounted: readonly string[]): Promise<void>;
}

/** 文件实现：MAZI_HOME/skills.json（{ "mounted": ["id"] }）。 */
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

/** 使用情况：目录注入次数（运行期事实，进程内累计、重启清零）。 */
export interface SkillUsage {
    injections: number;
    lastInjectedAt?: number;
}

/** 列表视图（UI 数据面）。 */
export interface SkillView {
    id: string;
    name: string;
    description: string;
    scope: SkillRootScope;
    dir: string;
    /** SKILL.md 绝对路径（catalog 里给模型按需读取）。 */
    path: string;
    mounted: boolean;
    mountedAt?: number;
    /** frontmatter allowed-tools（解析展示；暂不参与判权）。 */
    allowedTools: readonly string[];
    resourceCount: number;
    bytes: number;
    usage: SkillUsage;
}

/** 详情视图：列表字段 + 正文 + frontmatter + 随包文件清单。 */
export interface SkillDetailView extends SkillView {
    body: string;
    frontmatter: SkillFrontmatter;
    resources: readonly string[];
}

/** L1 目录条目（注入系统提示的形态）。 */
export interface SkillCatalogEntry {
    id: string;
    name: string;
    description: string;
    path: string;
}

/** 工具调用 / 运行所属上下文：注入按 run 去重。 */
export interface SkillRunContext {
    rootGoalId: string;
    goalId?: string;
    taskId?: string;
}

/** 运行期 Skill 目录提供者（HarnessRuntime 消费）。 */
export interface SkillProvider {
    catalog(context: SkillRunContext): readonly SkillCatalogEntry[];
    mounted(): readonly string[];
}

export interface SkillAuditEntry {
    action: 'mount' | 'unmount';
    skillId: string;
    at: number;
}

export interface SkillUsageSummary {
    discovered: number;
    mounted: number;
    injections: number;
}

export interface SkillRuntimeOptions {
    registry: SkillRegistry;
    state: SkillMountStore;
    now?: () => number;
    /** 挂载/卸载审计回调（宿主接行为流 / 日志）。 */
    onAudit?: (entry: SkillAuditEntry) => void;
}

/**
 * Skill 运行时：挂载状态 + catalog 注入 + 使用情况。
 * 不含任何工具/权限/数据集合语义——那是插件 / MCP 的职责。
 */
export class SkillRuntime implements SkillProvider {
    readonly registry: SkillRegistry;
    private readonly state: SkillMountStore;
    private readonly now: () => number;
    private readonly onAudit?: (entry: SkillAuditEntry) => void;
    private readonly mountedIds = new Set<string>();
    private readonly mountedAt = new Map<string, number>();
    private readonly usageById = new Map<string, SkillUsage>();
    private readonly lastRunBySkill = new Map<string, string>();

    constructor(options: SkillRuntimeOptions) {
        this.registry = options.registry;
        this.state = options.state;
        this.now = options.now ?? Date.now;
        if (options.onAudit !== undefined) this.onAudit = options.onAudit;
    }

    /** 读取挂载状态（进程启动 / 重扫后调用）。 */
    async init(): Promise<void> {
        const ids = await this.state.read();
        this.mountedIds.clear();
        this.mountedAt.clear();
        for (const id of ids) {
            if (this.registry.get(id) === undefined) continue;
            this.mountedIds.add(id);
            this.mountedAt.set(id, this.now());
        }
    }

    list(): readonly SkillView[] {
        return this.registry.list().map((snapshot) => this.viewOf(snapshot));
    }

    detail(id: string): SkillDetailView | undefined {
        const snapshot = this.registry.get(id);
        if (snapshot === undefined) return undefined;
        const document = snapshot.document;
        return {
            ...this.viewOf(snapshot),
            body: document.body,
            frontmatter: document.frontmatter,
            resources: document.resources,
        };
    }

    /** SKILL.md 正文（L2；宿主/UI 读取，不自动注入）。 */
    instructions(id: string): string | undefined {
        return this.registry.get(id)?.document.body;
    }

    errors(): ReturnType<SkillRegistry['errors']> {
        return this.registry.errors();
    }

    shadowed(): ReturnType<SkillRegistry['shadowed']> {
        return this.registry.shadowed();
    }

    mounted(): readonly string[] {
        return [...this.mountedIds].sort();
    }

    isMounted(id: string): boolean {
        return this.mountedIds.has(id);
    }

    /** 挂载（幂等）；未发现/未通过校验的 Skill 拒绝挂载，且不落状态。 */
    async mount(id: string): Promise<SkillView> {
        const snapshot = this.registry.get(id);
        if (snapshot === undefined) throw new Error('技能不存在或未通过校验：' + id);
        if (!this.mountedIds.has(id)) {
            this.mountedIds.add(id);
            const at = this.now();
            this.mountedAt.set(id, at);
            await this.state.write(this.mounted());
            this.onAudit?.({ action: 'mount', skillId: id, at });
        }
        return this.viewOf(snapshot);
    }

    /** 卸载（幂等）：从 catalog 立即移除（不影响工具面与权限）。 */
    async unmount(id: string): Promise<boolean> {
        if (!this.mountedIds.has(id)) return false;
        this.mountedIds.delete(id);
        this.mountedAt.delete(id);
        this.lastRunBySkill.delete(id);
        const at = this.now();
        await this.state.write(this.mounted());
        this.onAudit?.({ action: 'unmount', skillId: id, at });
        return true;
    }

    /** L1 目录：已挂载 Skill 的 name/description/path；同一 run 只计一次注入。 */
    catalog(context: SkillRunContext): readonly SkillCatalogEntry[] {
        const entries: SkillCatalogEntry[] = [];
        for (const snapshot of this.registry.list()) {
            const document = snapshot.document;
            if (!this.mountedIds.has(document.id)) continue;
            entries.push({
                id: document.id,
                name: document.name,
                description: document.description,
                path: document.path,
            });
            this.recordInjection(document.id, context.rootGoalId);
        }
        return entries;
    }

    usageOf(id: string): SkillUsage {
        const usage = this.usageById.get(id);
        return usage === undefined ? { injections: 0 } : { ...usage };
    }

    usageSummary(): SkillUsageSummary {
        let injections = 0;
        for (const usage of this.usageById.values()) injections += usage.injections;
        return {
            discovered: this.registry.list().length,
            mounted: this.mountedIds.size,
            injections,
        };
    }

    private recordInjection(id: string, runKey: string): void {
        if (this.lastRunBySkill.get(id) === runKey) return;
        this.lastRunBySkill.set(id, runKey);
        const usage = this.usageById.get(id) ?? { injections: 0 };
        usage.injections += 1;
        usage.lastInjectedAt = this.now();
        this.usageById.set(id, usage);
    }

    private viewOf(snapshot: SkillSnapshot): SkillView {
        const document: SkillDocument = snapshot.document;
        const mountedAt = this.mountedAt.get(document.id);
        return {
            id: document.id,
            name: document.name,
            description: document.description,
            scope: snapshot.scope,
            dir: document.dir,
            path: document.path,
            mounted: this.mountedIds.has(document.id),
            ...(mountedAt !== undefined ? { mountedAt } : {}),
            allowedTools: document.frontmatter.allowedTools ?? [],
            resourceCount: document.resources.length,
            bytes: document.bytes,
            usage: this.usageOf(document.id),
        };
    }
}
