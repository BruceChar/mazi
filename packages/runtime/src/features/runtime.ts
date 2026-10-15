/**
 * FeatureRuntime —— 特性开关的 CRUD 与运行期解析（docs/AB测试设计.md §3）。
 *
 * 开关是用户资产：定义落 $MAZI_HOME/features.json；运行期 resolve() 产出
 * EffectiveFeatures（全局默认 + 本次 run override），交给 HarnessRuntime 应用。
 * Feature 不注册工具、不放宽权限——只能追加提示片段、调整技能集合、收窄工具面。
 */

import type { EffectiveFeatures, FeatureDefinition, FeatureSkillMode } from '@mazi/core';
import { isValidFeatureId, resolveFeatures } from '@mazi/core';
import type { FeatureStore } from './store.js';
import {
    coerceFeatureDefinition,
    FeatureConflictError,
    FeatureValidationError,
} from './validate.js';

/** 新建输入（enabled 缺省 false）。 */
export interface FeatureInput {
    id: string;
    name: string;
    description: string;
    enabled?: boolean;
    promptFragment?: string;
    skills?: string[];
    skillMode?: FeatureSkillMode;
    allowedTools?: string[];
    reasoningLevel?: string;
}

/** 局部更新：字段缺省 = 不变；可清空字段用 null。 */
export interface FeaturePatch {
    name?: string;
    description?: string;
    enabled?: boolean;
    promptFragment?: string | null;
    skills?: string[] | null;
    skillMode?: FeatureSkillMode | null;
    allowedTools?: string[] | null;
    reasoningLevel?: string | null;
}

export interface FeatureSummary {
    total: number;
    enabled: number;
    ids: string[];
}

export interface FeatureRuntimeOptions {
    store: FeatureStore;
    now?: () => number;
    onWarning?: (message: string) => void;
}

function byId(a: { id: string }, b: { id: string }): number {
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export class FeatureRuntime {
    private features: FeatureDefinition[] = [];
    private loaded = false;
    private readonly store: FeatureStore;
    private readonly now: () => number;
    private readonly onWarning?: (message: string) => void;

    constructor(options: FeatureRuntimeOptions) {
        this.store = options.store;
        this.now = options.now ?? Date.now;
        if (options.onWarning !== undefined) this.onWarning = options.onWarning;
    }

    /** 读取定义（进程启动 / 外部改动后调用）。 */
    async init(): Promise<void> {
        this.features = (await this.store.read()).slice().sort(byId);
        this.loaded = true;
    }

    list(): readonly FeatureDefinition[] {
        return [...this.features];
    }

    get(id: string): FeatureDefinition | undefined {
        return this.features.find((feature) => feature.id === id);
    }

    enabledIds(): string[] {
        return this.features.filter((feature) => feature.enabled).map((feature) => feature.id);
    }

    summary(): FeatureSummary {
        return {
            total: this.features.length,
            enabled: this.features.filter((feature) => feature.enabled).length,
            ids: this.features.map((feature) => feature.id),
        };
    }

    /** 解析一次运行的有效开关（纯函数委托；Feature 只影响提示/技能/工具面）。 */
    resolve(overrides: Readonly<Record<string, boolean>> = {}): EffectiveFeatures {
        return resolveFeatures(this.features, overrides);
    }

    /** 新建（重复 id → FeatureConflictError；非法定义 → FeatureValidationError）。 */
    async create(input: FeatureInput): Promise<FeatureDefinition> {
        await this.ensureLoaded();
        const id = typeof input.id === 'string' ? input.id.trim() : '';
        if (!isValidFeatureId(id)) {
            throw new FeatureValidationError('id 必须为 kebab-case（小写字母/数字，连字符分隔）');
        }
        if (this.get(id) !== undefined) throw new FeatureConflictError(id);
        const normalized = coerceFeatureDefinition({
            ...input,
            id,
            enabled: input.enabled === true,
        });
        if (normalized === undefined) {
            throw new FeatureValidationError('特性定义非法：name/description 必填');
        }
        const now = this.now();
        const created: FeatureDefinition = {
            ...normalized,
            createdAt: normalized.createdAt ?? now,
            updatedAt: now,
        };
        this.features = [...this.features, created].sort(byId);
        await this.persist();
        return created;
    }

    /** 局部更新（不存在 → undefined）；id 不可改。 */
    async update(id: string, patch: FeaturePatch): Promise<FeatureDefinition | undefined> {
        await this.ensureLoaded();
        const current = this.get(id);
        if (current === undefined) return undefined;
        const next: FeatureDefinition = { ...current, updatedAt: this.now() };
        applyPatch(next, patch);
        const normalized = coerceFeatureDefinition(next);
        if (normalized === undefined) {
            throw new FeatureValidationError('更新后定义非法：name/description 必填');
        }
        // 保留创建时间，且不得因归一丢失 id（id 不参与 patch）。
        const merged: FeatureDefinition = {
            ...normalized,
            id: current.id,
            createdAt: current.createdAt ?? normalized.createdAt,
        };
        this.features = this.features.map((feature) => (feature.id === id ? merged : feature));
        await this.persist();
        return merged;
    }

    /** 删除（幂等）。 */
    async remove(id: string): Promise<boolean> {
        await this.ensureLoaded();
        const before = this.features.length;
        this.features = this.features.filter((feature) => feature.id !== id);
        if (this.features.length === before) return false;
        await this.persist();
        return true;
    }

    private async ensureLoaded(): Promise<void> {
        if (!this.loaded) await this.init();
    }

    private async persist(): Promise<void> {
        await this.store.write([...this.features].sort(byId));
    }
}

/** 把 patch 应用到定义（缺省不变；null 清空可空字段）。 */
function applyPatch(target: FeatureDefinition, patch: FeaturePatch): void {
    if (patch.name !== undefined) target.name = patch.name;
    if (patch.description !== undefined) target.description = patch.description;
    if (patch.enabled !== undefined) target.enabled = patch.enabled;
    if (patch.promptFragment !== undefined) {
        setOrClear(target, 'promptFragment', patch.promptFragment);
    }
    if (patch.skills !== undefined) setOrClear(target, 'skills', patch.skills);
    if (patch.skillMode !== undefined) setOrClear(target, 'skillMode', patch.skillMode);
    if (patch.allowedTools !== undefined) {
        setOrClear(target, 'allowedTools', patch.allowedTools);
    }
    if (patch.reasoningLevel !== undefined) {
        setOrClear(target, 'reasoningLevel', patch.reasoningLevel);
    }
}

function setOrClear<K extends keyof FeatureDefinition>(
    target: FeatureDefinition,
    key: K,
    value: FeatureDefinition[K] | null,
): void {
    if (value === null) {
        delete target[key];
        return;
    }
    target[key] = value;
}
