import 'reflect-metadata';
import type { FailureLedgerView } from '@mazi/libs';
import type { FailureLedgerQuery } from '@mazi/runtime';
import { Injectable } from '@nestjs/common';
import Logger from '../common/log.js';
import { ApiRuntimeService } from '../common/runtime.service.js';

/** 失败分类账只读查询（GET /api/ledger）。 */
@Injectable()
export class LedgerService {
    private readonly logger = new Logger('ledger');

    constructor(private readonly runtime: ApiRuntimeService) {}

    async list(query: FailureLedgerQuery): Promise<{ entries: FailureLedgerView[] }> {
        const entries = await this.runtime.harness().listFailures(query);
        this.logger.debug(
            `list kind=${query.kind ?? '-'} limit=${query.limit ?? '-'} → ${entries.length}`,
        );
        return { entries };
    }
}
