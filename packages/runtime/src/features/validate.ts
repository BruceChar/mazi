/**
 * Feature 定义校验与归一 —— docs/AB测试设计.md §3.3。
 *
 * 唯一校验入口：文件读取（features.json）与 API 写入都经此，避免「落盘合法、
 * 读回非法」的分叉。非法定义在读取时被丢弃（不阻断运行），在写入时抛错。
 */

import type { FeatureDefinition, FeatureSkillMode } from '@mazi/core';
import { isValidFeatureId } from '@mazi/core';

/** 写入侧校验失败（API → 400）。 */
export class FeatureValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FeatureValidationError';
    }
}

/** 同 id 冲突（API → 409）。 */
export class FeatureConflictError extends Error {
    constructor(id: string) {
        super('同名特性已存在：' + id);
        this.name = 'FeatureConflictError';
    }
}

function trimmed(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function stringList(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const items = value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    return items.length > 0 ? [...new Set(items)].sort() : undefined;
}

function skillModeOf(value: unknown): FeatureSkillMode | undefined {
    return value === 'add' || value === 'only' ? value : undefined;
}

/**
 * 把未知输入归一为 FeatureDefinition；缺少 id/name/description 或 id 非法 → undefined。
 * 读取路径据此丢弃坏记录（文件损坏降级为空集合，见 §3.3）。
 */
export function coerceFeatureDefinition(value: unknown): FeatureDefinition | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    const record = value as Record<string, unknown>;
    const id = trimmed(record.id);
    const name = trimmed(record.name);
    const description = trimmed(record.description);
    if (id === undefined || !isValidFeatureId(id)) return undefined;
    if (name === undefined || description === undefined) return undefined;

    const definition: FeatureDefinition = {
        id,
        name,
        description,
        enabled: record.enabled === true,
    };
    const promptFragment = trimmed(record.promptFragment);
    if (promptFragment !== undefined) definition.promptFragment = promptFragment;
    const skills = stringList(record.skills);
    if (skills !== undefined) definition.skills = skills;
    const skillMode = skillModeOf(record.skillMode);
    if (skillMode !== undefined) definition.skillMode = skillMode;
    const allowedTools = stringList(record.allowedTools);
    if (allowedTools !== undefined) definition.allowedTools = allowedTools;
    const reasoningLevel = trimmed(record.reasoningLevel);
    if (reasoningLevel !== undefined) definition.reasoningLevel = reasoningLevel;
    if (typeof record.createdAt === 'number') definition.createdAt = record.createdAt;
    if (typeof record.updatedAt === 'number') definition.updatedAt = record.updatedAt;
    return definition;
}
