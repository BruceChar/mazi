import 'reflect-metadata';
import {
    FeatureConflictError,
    type FeatureInput,
    type FeaturePatch,
    FeatureValidationError,
} from '@mazi/runtime';
import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import { ApiRuntimeService } from '../common/runtime.service.js';

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)
        : undefined;
}

function optionalText(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function stringList(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    return value.filter((item): item is string => typeof item === 'string');
}

function skillModeOf(value: unknown): 'add' | 'only' | undefined {
    return value === 'add' || value === 'only' ? value : undefined;
}

/** 新建入参（缺省字段不落库；校验归 FeatureRuntime）。 */
function featureInputOf(body: unknown): FeatureInput {
    const record = asRecord(body) ?? {};
    const input: FeatureInput = {
        id: typeof record.id === 'string' ? record.id : '',
        name: typeof record.name === 'string' ? record.name : '',
        description: typeof record.description === 'string' ? record.description : '',
    };
    if (typeof record.enabled === 'boolean') input.enabled = record.enabled;
    const promptFragment = optionalText(record.promptFragment);
    if (promptFragment !== undefined) input.promptFragment = promptFragment;
    const skills = stringList(record.skills);
    if (skills !== undefined) input.skills = skills;
    const skillMode = skillModeOf(record.skillMode);
    if (skillMode !== undefined) input.skillMode = skillMode;
    const allowedTools = stringList(record.allowedTools);
    if (allowedTools !== undefined) input.allowedTools = allowedTools;
    const reasoningLevel = optionalText(record.reasoningLevel);
    if (reasoningLevel !== undefined) input.reasoningLevel = reasoningLevel;
    return input;
}

/** 局部更新：字段缺省 = 不变；null = 清空（可空字段）。 */
function featurePatchOf(body: unknown): FeaturePatch {
    const record = asRecord(body) ?? {};
    const patch: FeaturePatch = {};
    if (typeof record.name === 'string') patch.name = record.name;
    if (typeof record.description === 'string') patch.description = record.description;
    if (typeof record.enabled === 'boolean') patch.enabled = record.enabled;
    if ('promptFragment' in record) {
        patch.promptFragment =
            record.promptFragment === null ? null : (optionalText(record.promptFragment) ?? null);
    }
    if ('skills' in record) {
        patch.skills = record.skills === null ? null : (stringList(record.skills) ?? null);
    }
    if ('skillMode' in record) patch.skillMode = skillModeOf(record.skillMode) ?? null;
    if ('allowedTools' in record) {
        patch.allowedTools =
            record.allowedTools === null ? null : (stringList(record.allowedTools) ?? null);
    }
    if ('reasoningLevel' in record) {
        patch.reasoningLevel =
            record.reasoningLevel === null ? null : (optionalText(record.reasoningLevel) ?? null);
    }
    return patch;
}

/** 运行期开关覆盖（只取布尔值）。 */
function flagOverridesOf(value: unknown): Record<string, boolean> {
    const record = asRecord(value);
    const overrides: Record<string, boolean> = {};
    if (record === undefined) return overrides;
    for (const [key, raw] of Object.entries(record)) {
        if (typeof raw === 'boolean') overrides[key] = raw;
    }
    return overrides;
}

function rethrowFeatureError(error: unknown): never {
    if (error instanceof FeatureConflictError) throw new ApiError(409, error.message);
    if (error instanceof FeatureValidationError) throw new ApiError(400, error.message);
    throw error;
}

/**
 * Feature（特性开关）管理：CRUD + 运行期解析预览（docs/AB测试设计.md §8.1）。
 * 定义是用户资产（$MAZI_HOME/features.json）；开关只影响提示/技能/工具面，不放宽权限。
 */
@Controller('features')
export class FeaturesController {
    constructor(private readonly runtime: ApiRuntimeService) {}

    /** GET /api/features：定义 + 汇总 + 当前默认解析结果。 */
    @Get()
    async list(): Promise<Record<string, unknown>> {
        const features = await this.runtime.features();
        return {
            features: features.list(),
            summary: features.summary(),
            effective: features.resolve(),
        };
    }

    /** POST /api/features/resolve：给定 overrides 的解析预览（排障/面板用）。 */
    @Post('resolve')
    async resolve(@Body() body: unknown): Promise<unknown> {
        const record = asRecord(body) ?? {};
        return (await this.runtime.features()).resolve(flagOverridesOf(record.overrides));
    }

    /** POST /api/features：新建；非法定义 400、重复 id 409。 */
    @Post()
    async create(@Body() body: unknown) {
        const features = await this.runtime.features();
        try {
            return await features.create(featureInputOf(body));
        } catch (error) {
            rethrowFeatureError(error);
        }
    }

    /** GET /api/features/:id：单条定义。 */
    @Get(':id')
    async detail(@Param('id') id: string) {
        const feature = (await this.runtime.features()).get(id);
        if (feature === undefined) throw new ApiError(404, '特性不存在：' + id);
        return feature;
    }

    /** PATCH /api/features/:id：局部更新（含开关）；不存在 404。 */
    @Patch(':id')
    async update(@Param('id') id: string, @Body() body: unknown) {
        const features = await this.runtime.features();
        try {
            const updated = await features.update(id, featurePatchOf(body));
            if (updated === undefined) throw new ApiError(404, '特性不存在：' + id);
            return updated;
        } catch (error) {
            if (error instanceof ApiError) throw error;
            rethrowFeatureError(error);
        }
    }

    /** DELETE /api/features/:id：删除；不存在 404。 */
    @Delete(':id')
    async remove(@Param('id') id: string): Promise<{ ok: boolean; removed: boolean }> {
        const removed = await (await this.runtime.features()).remove(id);
        if (!removed) throw new ApiError(404, '特性不存在：' + id);
        return { ok: true, removed };
    }
}
