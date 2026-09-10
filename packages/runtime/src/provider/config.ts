/**
 * Provider 配置与启动校验 —— 实现 AHF_RUNTIME_PROVIDER §9.1/§9.2。
 * Provider = 端点（凭据/baseUrl/超时/共享限额）；模型 = 画像载体（capabilities + pricing）。
 * validateProviderConfig 硬失败即抛 ConfigValidationError（进程 abort 语义），警告以数组返回。
 */

import type { ContentType, ProviderCapabilities } from '@mazi/core';
import type { PricingSchedule } from './pricing.js';

export interface ProviderLimitsConfig {
    rpm?: number;
    tpm?: number;
    concurrency?: number;
}

export interface ProviderModelConfig {
    id: string;
    name?: string;
    timeoutMs?: number;
    capabilities: ProviderCapabilities;
    pricing?: PricingSchedule;
    /** 语义标签（§7.3 perTag 归组）；未知值仅警告（§9.2） */
    tags?: string[];
}

export interface ProviderConfig {
    id: string;
    adapter: string;
    /** 显式声明读取的环境变量；声明且缺失 = 硬失败 */
    apiKeyEnv?: string;
    /** OpenAI 兼容网关等一等字段（§9.1） */
    baseUrl?: string;
    timeoutMs?: number;
    limits?: ProviderLimitsConfig;
    models: ProviderModelConfig[];
}

export type ValidationWarningKind = 'no-default-env' | 'unknown-specialty';

export interface ValidationWarning {
    kind: ValidationWarningKind;
    providerId: string;
    modelId?: string;
    message: string;
}

/** 抓 typo 用已知专长集合（§7.2 列表子集；语义标签开放，未知仅警告） */
export const KNOWN_SPECIALTIES: readonly string[] = [
    'frontend-ui-generation',
    'code-refactoring',
    'data-analysis',
    'creative-writing',
    'math-reasoning',
    'summarization',
    'translation',
    'long-document-analysis',
    'scenario-dialogue',
    'scientific-research',
    'multimodal-understanding',
    'tool-use-reliability',
    'fast-classification',
];

export class ConfigValidationError extends Error {
    readonly problems: string[];
    constructor(problems: string[]) {
        super(`provider config validation failed:\n${problems.map((p) => ` - ${p}`).join('\n')}`);
        this.name = 'ConfigValidationError';
        this.problems = problems;
    }
}

const CONTENT_TYPES: readonly string[] = [
    'text',
    'image',
    'audio',
    'video',
    'document',
    'spreadsheet',
    'code',
];

function isContentType(value: string): boolean {
    return CONTENT_TYPES.includes(value);
}

function validatePricingProblems(pricing: PricingSchedule, at: string, problems: string[]): void {
    if (pricing.currency !== 'USD') problems.push(`${at}: currency must be 'USD'`);
    const base = pricing.base;
    const prices: Array<[string, number | undefined]> = [
        ['inputPerMTok', base.inputPerMTok],
        ['outputPerMTok', base.outputPerMTok],
        ['cacheWritePerMTok', base.cacheWritePerMTok],
        ['cacheReadPerMTok', base.cacheReadPerMTok],
        ['reasoningPerMTok', base.reasoningPerMTok],
    ];
    for (const [key, value] of prices) {
        if (value !== undefined && !(value > 0)) {
            problems.push(`${at}: pricing.base.${key} must be > 0`);
        }
    }
    for (const tier of pricing.tiers) {
        if (!(tier.multiplier > 0)) {
            problems.push(`${at}: tier '${tier.name}' multiplier must be > 0`);
        }
        const [start, end] = tier.windowHoursUtc;
        const valid =
            Number.isInteger(start) &&
            Number.isInteger(end) &&
            start >= 0 &&
            start <= 23 &&
            end >= 0 &&
            end <= 23 &&
            start !== end;
        if (!valid) {
            problems.push(
                `${at}: tier '${tier.name}' windowHoursUtc invalid (start===end or out of 0-23)`,
            );
        }
    }
}

export interface ValidateOptions {
    /** faux 防线（§9.3）：生产装配必须 false */
    allowFaux?: boolean;
    env?: Record<string, string | undefined>;
}

/** 启动校验：硬失败抛 ConfigValidationError；警告以数组返回。 */
export function validateProviderConfig(
    config: ProviderConfig,
    options: ValidateOptions = {},
): ValidationWarning[] {
    const allowFaux = options.allowFaux ?? false;
    const env = options.env ?? {};
    const problems: string[] = [];
    const warnings: ValidationWarning[] = [];
    const at = `providers[${config.id}]`;

    if (!config.id || typeof config.id !== 'string') problems.push('provider id required');
    if (!config.adapter || typeof config.adapter !== 'string') {
        problems.push(`${at}: adapter required`);
    } else if (config.adapter === 'faux' && !allowFaux) {
        problems.push(
            `${at}: adapter 'faux' not allowed (faux 防线 §9.3; set allowFaux only for tests / MAZI_ALLOW_FAUX=1)`,
        );
    }
    if (config.timeoutMs !== undefined && !(config.timeoutMs > 0)) {
        problems.push(`${at}: timeoutMs must be > 0`);
    }
    if (config.limits) {
        const limits = config.limits;
        for (const key of ['rpm', 'tpm', 'concurrency'] as const) {
            const value = limits[key];
            if (value !== undefined && !(value > 0))
                problems.push(`${at}: limits.${key} must be > 0`);
        }
    }
    if (config.apiKeyEnv && !env[config.apiKeyEnv]) {
        problems.push(
            `${at}: apiKeyEnv '${config.apiKeyEnv}' declared but missing from environment`,
        );
    }
    if (!config.apiKeyEnv && config.adapter !== 'faux' && !config.baseUrl) {
        warnings.push({
            kind: 'no-default-env',
            providerId: config.id,
            message: `adapter '${config.adapter}' has no apiKeyEnv and no baseUrl (local/keyless endpoint assumed; not verified)`,
        });
    }

    if (!Array.isArray(config.models) || config.models.length === 0) {
        problems.push(`${at}: at least one model required`);
    }
    const modelIds = new Set<string>();
    for (const model of config.models) {
        const mat = `${at}.models[${model.id}]`;
        if (modelIds.has(model.id)) problems.push(`${at}: duplicate model id '${model.id}'`);
        modelIds.add(model.id);
        if (model.timeoutMs !== undefined && !(model.timeoutMs > 0)) {
            problems.push(`${mat}: timeoutMs must be > 0`);
        }
        // capabilities 形状（§9.2）
        const caps = model.capabilities;
        if (
            typeof caps !== 'object' ||
            caps === null ||
            typeof caps.supportsToolCalls !== 'boolean' ||
            typeof caps.supportsStreaming !== 'boolean'
        ) {
            problems.push(
                `${mat}: capabilities must declare supportsToolCalls/supportsStreaming booleans`,
            );
        } else {
            const allTypes = [...caps.inputTypes, ...caps.outputTypes];
            for (const type of allTypes) {
                if (!isContentType(type)) {
                    problems.push(
                        `${mat}: unknown content type '${type}' in capabilities (allowed: ${CONTENT_TYPES.join(',')})`,
                    );
                }
            }
            if ((caps.maxInputTokens ?? 0) < 0 || (caps.maxOutputTokens ?? 0) < 0) {
                problems.push(`${mat}: maxInputTokens/maxOutputTokens must be >= 0`);
            }
        }
        if (model.pricing) validatePricingProblems(model.pricing, mat, problems);
        for (const tag of model.tags ?? []) {
            if (!KNOWN_SPECIALTIES.includes(tag)) {
                warnings.push({
                    kind: 'unknown-specialty',
                    providerId: config.id,
                    modelId: model.id,
                    message: `specialty tag '${tag}' not in KNOWN_SPECIALTIES (typo?); open values allowed`,
                });
            }
        }
    }

    if (problems.length > 0) throw new ConfigValidationError(problems);
    return warnings;
}
