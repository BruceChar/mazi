/**
 * Experiment 定义校验 —— docs/AB测试设计.md §5 / §8。
 *
 * 唯一入口：API 写入前校验（非法入参 → 400），保证落进实验日志的 spec 是完整的
 * 「两臂 + 控制变量」。校验只做机械约束（结构 / 闭集 / 数量），不判断实验设计好坏。
 */

import type {
    ExperimentArmSpec,
    ExperimentBaseline,
    ExperimentSpec,
    ExperimentVariable,
} from '@mazi/core';
import { isExperimentVariableKind } from '@mazi/core';

export class ExperimentSpecError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ExperimentSpecError';
    }
}

function requiredText(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new ExperimentSpecError(field + ' 必填');
    }
    return value.trim();
}

function optionalText(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function textList(value: unknown): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw new ExperimentSpecError('skills 必须是字符串数组');
    const items = value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    return [...new Set(items)].sort();
}

function flagMap(value: unknown): Record<string, boolean> | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new ExperimentSpecError('features 必须是 { id: boolean } 对象');
    }
    const out: Record<string, boolean> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        if (typeof raw !== 'boolean')
            throw new ExperimentSpecError('features.' + key + ' 必须是布尔');
        out[key] = raw;
    }
    return out;
}

function baselineOf(value: unknown): ExperimentBaseline {
    if (value === undefined) return {};
    if (typeof value !== 'object' || value === null)
        throw new ExperimentSpecError('baseline 必须是对象');
    const record = value as Record<string, unknown>;
    const baseline: ExperimentBaseline = {};
    const modelId = optionalText(record.modelId);
    if (modelId !== undefined) baseline.modelId = modelId;
    const skillIds = textList(record.skillIds);
    if (skillIds !== undefined) baseline.skillIds = skillIds;
    const features = flagMap(record.features);
    if (features !== undefined) baseline.features = features;
    const permissionCeiling = optionalText(record.permissionCeiling);
    if (permissionCeiling !== undefined) baseline.permissionCeiling = permissionCeiling;
    const reasoningLevel = optionalText(record.reasoningLevel);
    if (reasoningLevel !== undefined) baseline.reasoningLevel = reasoningLevel;
    return baseline;
}

function armOf(value: unknown, index: number): ExperimentArmSpec {
    if (typeof value !== 'object' || value === null) {
        throw new ExperimentSpecError('arms[' + index + '] 必须是对象');
    }
    const record = value as Record<string, unknown>;
    const label = optionalText(record.label) ?? (index === 0 ? 'A' : 'B');
    const arm: ExperimentArmSpec = { label };
    const modelId = optionalText(record.modelId);
    if (modelId !== undefined) arm.modelId = modelId;
    const skills = textList(record.skills);
    if (skills !== undefined) arm.skills = skills;
    const features = flagMap(record.features);
    if (features !== undefined) arm.features = features;
    const permissionCeiling = optionalText(record.permissionCeiling);
    if (permissionCeiling !== undefined) arm.permissionCeiling = permissionCeiling;
    const reasoningLevel = optionalText(record.reasoningLevel);
    if (reasoningLevel !== undefined) arm.reasoningLevel = reasoningLevel;
    return arm;
}

function variablesOf(value: unknown): ExperimentVariable[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new ExperimentSpecError('variables 至少声明一项自变量');
    }
    return value.map((raw, index) => {
        if (typeof raw !== 'object' || raw === null) {
            throw new ExperimentSpecError('variables[' + index + '] 必须是对象');
        }
        const record = raw as Record<string, unknown>;
        if (!isExperimentVariableKind(record.kind)) {
            throw new ExperimentSpecError('variables[' + index + '].kind 不在闭集内');
        }
        const label = optionalText(record.label) ?? String(record.kind);
        return {
            kind: record.kind,
            label,
            baseline: record.baseline ?? null,
            treatment: record.treatment ?? null,
        };
    });
}

/**
 * 校验并归一实验定义。
 * 机械约束：title/input 必填、恰好两臂且 label 唯一、variables 至少一项且 kind 在闭集内。
 */
export function validateExperimentSpec(input: unknown): ExperimentSpec {
    if (typeof input !== 'object' || input === null) {
        throw new ExperimentSpecError('缺少请求体');
    }
    const record = input as Record<string, unknown>;
    const title = requiredText(record.title, 'title');
    const experimentInput = requiredText(record.input, 'input');
    if (!Array.isArray(record.arms) || record.arms.length !== 2) {
        throw new ExperimentSpecError('arms 必须恰好两个（A/B 对照）');
    }
    const arms = record.arms.map((arm, index) => armOf(arm, index));
    const labels = new Set(arms.map((arm) => arm.label));
    if (labels.size !== 2) throw new ExperimentSpecError('两臂 label 必须不同');

    const spec: ExperimentSpec = {
        title,
        input: experimentInput,
        baseline: baselineOf(record.baseline),
        variables: variablesOf(record.variables),
        arms,
    };
    const hypothesis = optionalText(record.hypothesis);
    if (hypothesis !== undefined) spec.hypothesis = hypothesis;
    const workspace = optionalText(record.workspace);
    if (workspace !== undefined) spec.workspace = workspace;
    return spec;
}
