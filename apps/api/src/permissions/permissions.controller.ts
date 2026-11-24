import 'reflect-metadata';
import { authz, type HarnessEvent } from '@mazi/core';
import { DefaultEventBus } from '@mazi/runtime';
import { Controller, Get, Query } from '@nestjs/common';

import { ApiRuntimeService } from '../common/runtime.service.js';
import { ConversationsService } from '../conversations/conversations.service.js';

/**
 * 权限审计端点（R3）：
 * GET /api/permissions/audit?rootGoalId=&projectId=&conversationId=&actor=&result=&tool=&keyword=&from=&to=
 *
 * 同源口径：始终以 replayAll() 全集为底抽取，再按 rootGoalId / projectId /
 * conversationId 圈定子集。右侧当前 run 面板是全集的 rootGoalId 子集；
 * 用户中心审计视图即全集。记录经会话映射补齐 conversationId/projectId。
 * 所有事件只追加，不做变更。
 */
@Controller('permissions')
export class PermissionsController {
    constructor(
        private readonly runtime: ApiRuntimeService,
        private readonly conversations: ConversationsService,
    ) {}

    @Get('audit')
    audit(
        @Query('sessionId') _sessionId?: string,
        @Query('actor') actor?: string,
        @Query('result') result?: string,
        @Query('tool') tool?: string,
        @Query('keyword') keyword?: string,
        @Query('rootGoalId') rootGoalId?: string,
        @Query('from') from?: string,
        @Query('to') to?: string,
        @Query('projectId') projectId?: string,
        @Query('conversationId') conversationId?: string,
    ) {
        const bus = this.runtime.harness().eventBus as DefaultEventBus;
        const records = authz.extractPermissionEvents(bus.replayAll());

        type RunContext = ReturnType<ConversationsService['runContext']>;
        const contextCache = new Map<string, RunContext>();
        const resolve = (rootGoalId: string): RunContext | undefined => {
            let ctx = contextCache.get(rootGoalId);
            if (ctx === undefined) {
                ctx = this.conversations.runContext(rootGoalId);
                contextCache.set(rootGoalId, ctx);
            }
            return ctx;
        };

        const resolved = records.map((record) => {
            const ctx = resolve(record.rootGoalId);
            return {
                ...record,
                ...(ctx?.conversationId ? { conversationId: ctx.conversationId } : {}),
                ...(ctx?.projectId ? { projectId: ctx.projectId } : {}),
            };
        });

        const scoped = resolved.filter((record) => {
            if (rootGoalId !== undefined && record.rootGoalId !== rootGoalId) return false;
            if (projectId !== undefined && record.projectId !== projectId) return false;
            if (conversationId !== undefined && record.conversationId !== conversationId)
                return false;
            return true;
        });

        const filtered = authz.filterPermissionEvents(scoped, {
            ...(actor ? { actor: actor as authz.PermissionActor } : {}),
            ...(result ? { result: result as authz.PermissionResult } : {}),
            ...(tool ? { tool } : {}),
            ...(keyword ? { keyword } : {}),
            ...(from !== undefined ? { from: Number(from) } : {}),
            ...(to !== undefined ? { to: Number(to) } : {}),
        });
        return { records: filtered };
    }
}
