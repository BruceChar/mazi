/**
 * StorageController —— 存储看板只读接口（docs/web/存储面板设计.md §3）。
 * GET /api/storage、/api/storage/tables/:name、/api/storage/search。
 */
import 'reflect-metadata';
import { Controller, Get, Param, Query } from '@nestjs/common';
import { StorageService } from './storage.service.js';

function toInt(raw: string | undefined, fallback: number, min: number, max: number): number {
    const value = Number(raw);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(Math.max(Math.floor(value), min), max);
}

@Controller('storage')
export class StorageController {
    constructor(private readonly storage: StorageService) {}

    @Get()
    overview(): ReturnType<StorageService['overview']> {
        return this.storage.overview();
    }

    @Get('tables/:name')
    table(
        @Param('name') name: string,
        @Query('limit') limit?: string,
        @Query('offset') offset?: string,
        @Query('q') q?: string,
    ): ReturnType<StorageService['tablePage']> {
        return this.storage.tablePage(name, {
            limit: toInt(limit, 50, 1, 200),
            offset: toInt(offset, 0, 0, Number.MAX_SAFE_INTEGER),
            query: (q ?? '').trim(),
        });
    }

    @Get('search')
    search(
        @Query('q') q?: string,
        @Query('limit') limit?: string,
    ): ReturnType<StorageService['search']> {
        return this.storage.search((q ?? '').trim(), toInt(limit, 5, 1, 50));
    }
}
