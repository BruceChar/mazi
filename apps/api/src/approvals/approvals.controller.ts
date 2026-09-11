import 'reflect-metadata';
import type { ApprovalSettlement } from '@mazi/runtime';
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import { ApiRuntimeService } from '../common/runtime.service.js';

interface SettleBody {
    decision?: unknown;
    scope?: unknown;
    reason?: unknown;
}

/**
 * 人审审批端点（V18/T8）：
 * - GET  /api/approvals            列出当前所有待审批请求（含签名的审批回显摘要）；
 * - POST /api/approvals/:id        结算一条审批（granted: once/session/workspace | rejected | cancelled）。
 *
 * `approval.requested/granted/cancelled` 同时经 /api/events/:id SSE 实时推送。
 */
@Controller('approvals')
export class ApprovalsController {
    constructor(private readonly runtime: ApiRuntimeService) {}

    @Get()
    list() {
        return { approvals: this.runtime.pendingApprovals() };
    }

    @Post(':id')
    settle(@Param('id') invocationId: string, @Body() body: SettleBody) {
        const settlement = this.parseSettlement(body);
        if (!this.runtime.settleApproval(invocationId, settlement)) {
            throw new ApiError(404, '审批不存在或已结算');
        }
        return { ok: true };
    }

    private parseSettlement(body: SettleBody): ApprovalSettlement {
        if (body?.decision === 'granted') {
            const scope = body.scope;
            if (scope !== 'once' && scope !== 'session' && scope !== 'workspace') {
                throw new ApiError(400, 'granted 需指定 scope：once | session | workspace');
            }
            return { decision: 'granted', scope };
        }
        if (body?.decision === 'rejected') {
            return {
                decision: 'rejected',
                ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
            };
        }
        if (body?.decision === 'cancelled') {
            return { decision: 'cancelled' };
        }
        throw new ApiError(400, 'decision 非法：granted | rejected | cancelled');
    }
}
