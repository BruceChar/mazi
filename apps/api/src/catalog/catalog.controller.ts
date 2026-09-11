import 'reflect-metadata';
import type { DriverConfig, OfferingId } from '@mazi/core';
import type { UsageFilter, UsageSummary } from '@mazi/runtime';
import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import { ApiRuntimeService } from '../common/runtime.service.js';

function optionalNumber(value: string | undefined): number | undefined {
    if (value === undefined || value === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalString(value: string | undefined): string | undefined {
    return value === undefined || value === '' ? undefined : value;
}

function usageFilterOf(query: Record<string, string | undefined>): UsageFilter {
    return {
        ...(optionalString(query.offeringId) !== undefined
            ? { offeringId: optionalString(query.offeringId) }
            : {}),
        ...(optionalString(query.modelId) !== undefined
            ? { modelId: optionalString(query.modelId) }
            : {}),
        ...(optionalString(query.providerId) !== undefined
            ? { providerId: optionalString(query.providerId) }
            : {}),
        ...(optionalNumber(query.catalogEpoch) !== undefined
            ? { catalogEpoch: optionalNumber(query.catalogEpoch) }
            : {}),
        ...(optionalNumber(query.from) !== undefined ? { from: optionalNumber(query.from) } : {}),
        ...(optionalNumber(query.to) !== undefined ? { to: optionalNumber(query.to) } : {}),
    };
}

function driverConfigOf(body: unknown): DriverConfig {
    if (typeof body !== 'object' || body === null) {
        throw new ApiError(400, '缺少 driverConfig');
    }
    const record = body as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : '';
    const offeringId = typeof record.offeringId === 'string' ? record.offeringId : '';
    if (id.length === 0 || offeringId.length === 0) {
        throw new ApiError(400, 'id 与 offeringId 必填');
    }
    const fallback = Array.isArray(record.fallbackOfferingIds)
        ? record.fallbackOfferingIds.filter((item): item is string => typeof item === 'string')
        : [];
    return {
        id,
        offeringId: offeringId as OfferingId,
        fallbackOfferingIds: fallback as OfferingId[],
    };
}

/** 模型目录与计费：目录快照 / 供应账本 / 审计变更 / DriverConfig（只读优先，写走 PG 语义的持久层）。 */
@Controller('catalog')
export class CatalogController {
    constructor(private readonly runtime: ApiRuntimeService) {}

    /** GET /api/catalog/snapshot：当前 epoch 的全部 active 供给（含合成能力与生效价目）。 */
    @Get('snapshot')
    async snapshot(): Promise<Record<string, unknown>> {
        const service = await this.runtime.catalog();
        const snapshot = service.snapshot();
        return { epoch: snapshot.epoch, builtAt: snapshot.builtAt, offerings: snapshot.offerings };
    }

    /** GET /api/catalog/changes?since=<epoch>：某 epoch 之后的目录变更审计。 */
    @Get('changes')
    async changes(@Query('since') since?: string): Promise<Record<string, unknown>> {
        const service = await this.runtime.catalog();
        const parsed = optionalNumber(since);
        const after = parsed === undefined ? -1 : parsed;
        return { epoch: service.epoch(), changes: await service.changesSince(after) };
    }

    /** GET /api/catalog/usage/summary：按 offering/model/provider/epoch 聚合的账本口径。 */
    @Get('usage/summary')
    async usageSummary(@Query() query: Record<string, string>): Promise<UsageSummary> {
        const service = await this.runtime.catalog();
        return service.usageSummary(usageFilterOf(query));
    }

    /** GET /api/catalog/usage：追加式凭证明细（append-only，永不 UPDATE/DELETE）。 */
    @Get('usage')
    async usage(@Query() query: Record<string, string>): Promise<Record<string, unknown>> {
        const service = await this.runtime.catalog();
        return { records: await service.usageRecords(usageFilterOf(query)) };
    }

    /** GET /api/catalog/driver-configs：默认绑定与迁移链。 */
    @Get('driver-configs')
    async listDriverConfigs(): Promise<Record<string, unknown>> {
        const service = await this.runtime.catalog();
        return { configs: service.facts().driverConfigs };
    }

    /** POST /api/catalog/driver-configs：写入/覆盖一条默认绑定。 */
    @Post('driver-configs')
    async setDriverConfig(@Body() body: unknown): Promise<Record<string, unknown>> {
        const service = await this.runtime.catalog();
        await service.setDriverConfig(driverConfigOf(body));
        return { configs: service.facts().driverConfigs };
    }

    /** POST /api/catalog/sync：把 providers.json 重新同步进目录，返回 diff 与 epoch。 */
    @Post('sync')
    async sync(): Promise<Record<string, unknown>> {
        return this.runtime.syncCatalog();
    }

    /** GET /api/catalog/health?offeringId=<id>：offering 级健康样本。 */
    @Get('health')
    async health(@Query('offeringId') offeringId?: string): Promise<Record<string, unknown>> {
        const service = await this.runtime.catalog();
        const samples = await service.healthSamples(
            optionalString(offeringId) as OfferingId | undefined,
        );
        return { samples };
    }
}
