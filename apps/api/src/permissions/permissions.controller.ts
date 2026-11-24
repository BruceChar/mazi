import 'reflect-metadata';
import { authz, type HarnessEvent } from '@mazi/core';
import { DefaultEventBus } from '@mazi/runtime';
import { Controller, Get, Query } from '@nestjs/common';

import { ApiRuntimeService } from '../common/runtime.service.js';

/**
 * 权限审计端点（R3）：
 * GET /api/permissions/audit?sessionId=&actor=&result=&tool=&keyword=
 *
 * 抽取会话内全部权限事件（用户批准/拒绝/取消、agent 自动放行、策略拒绝、
 * 记忆命中、撤销），保留角色、结果、工具、决策依据、作用域，按条件筛选。
 * 所有事件只追加，不做变更。
 */
@Controller('permissions')
export class PermissionsController {
    constructor(private readonly runtime: ApiRuntimeService) {}

    @Get('audit')
    audit(
        @Query('sessionId') sessionId?: string,
        @Query('actor') actor?: string,
        @Query('result') result?: string,
        @Query('tool') tool?: string,
        @Query('keyword') keyword?: string,
    ) {
        const bus = this.runtime.harness().eventBus as DefaultEventBus;
        const events: HarnessEvent[] = sessionId ? bus.replaySession(sessionId) : [];
        const records = authz.extractPermissionEvents(events);
        const filtered = authz.filterPermissionEvents(records, {
            ...(actor ? { actor: actor as authz.PermissionActor } : {}),
            ...(result ? { result: result as authz.PermissionResult } : {}),
            ...(tool ? { tool } : {}),
            ...(keyword ? { keyword } : {}),
        });
        return { records: filtered };
    }
}
