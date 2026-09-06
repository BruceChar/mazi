import 'reflect-metadata';
import type { FailureLedgerRecord } from '@mazi/core';
import { Injectable } from '@nestjs/common';
import { ApiRuntimeService } from '../common/runtime.service.js';

/** 失败分类账查询服务 */
@Injectable()
export class LedgerService {
    constructor(private readonly runtime: ApiRuntimeService) {}

    list(limit: number): Promise<FailureLedgerRecord[]> {
        return this.runtime.harness().store.listFailureRecords({ limit });
    }
}
