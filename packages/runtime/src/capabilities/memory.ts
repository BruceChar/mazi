/**
 * capabilities/memory.ts —— 能力包记忆命名空间（docs/能力包规范.md §6.2）。
 *
 * 命名空间键为 skills.<skillId>.<collection>：包间默认不可见；secret 集合只写不读回；
 * 是否注入 LLM 上下文由调用方按 sensitivity 决定（本模块的 list 访问 ≠ 注入授权）。
 */

import type {
    SkillId,
    SkillMemoryAccess,
    SkillMemoryCollection,
    SkillSensitivity,
} from '@mazi/core';

/** 命名空间键（审计/调试/测试可见形态）。 */
export function skillMemoryNamespaceKey(skillId: SkillId, collection: string): string {
    return `skills.${skillId}.${collection}`;
}

interface NamespaceRecords {
    skillId: SkillId;
    collection: string;
    records: Record<string, unknown>[];
}

function cloneRecord(record: Record<string, unknown>): Record<string, unknown> {
    return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
}

/** 进程内命名空间存储（包间隔离由 key 保证）。 */
export class SkillMemoryRegistry {
    private readonly spaces = new Map<string, NamespaceRecords>();

    append(skillId: SkillId, collection: string, record: Record<string, unknown>): void {
        const key = skillMemoryNamespaceKey(skillId, collection);
        const space = this.spaces.get(key) ?? { skillId, collection, records: [] };
        space.records.push(cloneRecord(record));
        this.spaces.set(key, space);
    }

    list(skillId: SkillId, collection: string): readonly Record<string, unknown>[] {
        const space = this.spaces.get(skillMemoryNamespaceKey(skillId, collection));
        return (space?.records ?? []).map(cloneRecord);
    }

    /** 删除某包全部记忆（治理删除 / 测试）。 */
    clear(skillId: SkillId): number {
        let removed = 0;
        for (const [key, space] of [...this.spaces]) {
            if (space.skillId !== skillId) continue;
            removed += space.records.length;
            this.spaces.delete(key);
        }
        return removed;
    }
}

/**
 * 单包命名空间视图：拒绝未声明的集合（机械边界），secret 集合恒不可读回。
 */
export class SkillMemoryNamespace implements SkillMemoryAccess {
    private readonly sensitivityByCollection = new Map<string, SkillSensitivity>();

    constructor(
        private readonly registry: SkillMemoryRegistry,
        private readonly skillId: SkillId,
        collections: readonly SkillMemoryCollection[],
    ) {
        for (const collection of collections) {
            this.sensitivityByCollection.set(collection.name, collection.sensitivity ?? 'normal');
        }
    }

    async append(collection: string, record: Record<string, unknown>): Promise<void> {
        this.assertDeclared(collection);
        this.registry.append(this.skillId, collection, record);
        return Promise.resolve();
    }

    async list(collection: string): Promise<readonly Record<string, unknown>[]> {
        this.assertDeclared(collection);
        if (this.sensitivityOf(collection) === 'secret') return [];
        return this.registry.list(this.skillId, collection);
    }

    /** 可写入 LLM 上下文的集合：仅 normal（sensitive/secret 默认不注入）。 */
    injectableCollections(): readonly string[] {
        return [...this.sensitivityByCollection]
            .filter(([, sensitivity]) => sensitivity === 'normal')
            .map(([name]) => name);
    }

    sensitivityOf(collection: string): SkillSensitivity {
        return this.sensitivityByCollection.get(collection) ?? 'normal';
    }

    private assertDeclared(collection: string): void {
        if (!this.sensitivityByCollection.has(collection)) {
            throw new Error(
                `能力包 ${this.skillId} 未声明的记忆集合：${collection}（manifest.memory.collections 之外禁止访问）`,
            );
        }
    }
}
