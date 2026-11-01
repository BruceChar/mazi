import 'reflect-metadata';
import type { MemoryWriteInput } from '@mazi/runtime';
import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import { ApiRuntimeService } from '../common/runtime.service.js';

function writeInputOf(body: Record<string, unknown>): MemoryWriteInput {
    const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
    const kind = typeof body.kind === 'string' ? body.kind.trim() : '';
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!userId || !kind || !text) {
        throw new ApiError(400, 'userId/kind/text 必填');
    }
    const links =
        typeof body.links === 'object' && body.links !== null
            ? (body.links as MemoryWriteInput['links'])
            : undefined;
    return {
        userId,
        kind,
        text,
        ...(typeof body.projectId === 'string' && body.projectId.trim()
            ? { projectId: body.projectId.trim() }
            : {}),
        ...(typeof body.workspaceId === 'string' && body.workspaceId.trim()
            ? { workspaceId: body.workspaceId.trim() }
            : {}),
        ...(Array.isArray(body.tags)
            ? {
                  tags: body.tags.filter((tag): tag is string => typeof tag === 'string'),
              }
            : {}),
        ...(typeof body.importance === 'number' ? { importance: body.importance } : {}),
        ...(links !== undefined ? { links } : {}),
    };
}

@Controller('memory')
export class MemoryController {
    constructor(private readonly runtime: ApiRuntimeService) {}

    @Get()
    async list(
        @Query('userId') userId?: string,
        @Query('projectId') projectId?: string,
        @Query('query') query?: string,
        @Query('limit') limit?: string,
    ) {
        const parsedLimit = Number(limit);
        const items = await this.runtime
            .harness()
            .personalMemoryService()
            .list({
                ...(userId ? { userId } : {}),
                ...(projectId ? { projectId } : {}),
                ...(query ? { queryText: query } : {}),
                ...(Number.isFinite(parsedLimit) && parsedLimit > 0
                    ? { limit: Math.min(200, Math.floor(parsedLimit)) }
                    : {}),
                unionScope: true,
            });
        return { items };
    }

    @Post()
    async remember(@Body() body: Record<string, unknown>) {
        const input = writeInputOf(body);
        const provenance =
            typeof body.provenance === 'object' && body.provenance !== null
                ? (body.provenance as Record<string, unknown>)
                : undefined;
        const inferred =
            provenance?.confidence === 'pending_confirmation' ||
            provenance?.source === 'model_inferred';
        const memory = this.runtime.harness().personalMemoryService();
        const item = inferred
            ? await memory.rememberCandidate(input)
            : await memory.rememberExplicit(input);
        return { item };
    }

    @Patch(':id')
    async update(@Param('id') memoryId: string, @Body() body: Record<string, unknown>) {
        const memory = this.runtime.harness().personalMemoryService();
        if (body.action === 'confirm') {
            const item = await memory.confirm(memoryId);
            if (item === undefined) throw new ApiError(404, '记忆不存在');
            return { item };
        }
        if (body.action === 'correct' && typeof body.text === 'string') {
            const item = await memory.correct(memoryId, body.text);
            if (item === undefined) throw new ApiError(404, '记忆不存在');
            return { item };
        }
        throw new ApiError(400, 'action 必须是 confirm | correct；correct 需要 text');
    }

    @Delete(':id')
    async forget(@Param('id') memoryId: string) {
        const item = await this.runtime.harness().personalMemoryService().forget(memoryId);
        if (item === undefined) throw new ApiError(404, '记忆不存在');
        return { ok: true, item };
    }
}
