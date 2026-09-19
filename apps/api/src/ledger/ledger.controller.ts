import 'reflect-metadata';
import { Controller, Get, Query } from '@nestjs/common';
import { LedgerService } from './ledger.service.js';

/** /api/ledger?kind=&limit=：失败分类账（Task 终态失败）。 */
@Controller('ledger')
export class LedgerController {
    constructor(private readonly ledger: LedgerService) {}

    @Get()
    list(@Query('kind') kind?: string, @Query('limit') limit?: string) {
        const parsed = limit !== undefined && /^\d+$/.test(limit) ? Number(limit) : undefined;
        return this.ledger.list({
            ...(kind ? { kind } : {}),
            ...(parsed !== undefined ? { limit: parsed } : {}),
        });
    }
}
