import 'reflect-metadata';
import type { FailureLedgerRecord } from '@mazi/core';
import { Controller, Get, Query } from '@nestjs/common';
import { LedgerService } from './ledger.service.js';

/** /api/ledger：失败分类账查询（GET /api/ledger?limit=） */
@Controller('ledger')
export class LedgerController {
    constructor(private readonly ledger: LedgerService) {}

    @Get()
    list(@Query('limit') limit?: string): Promise<FailureLedgerRecord[]> {
        return this.ledger.list(Number.parseInt(limit ?? '50', 10));
    }
}
