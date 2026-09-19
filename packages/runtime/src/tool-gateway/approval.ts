/**
 * ApprovalBroker — the human-in-the-loop ApprovalSeam (V3 §6.3, §7 floor 4).
 *
 * Each gated invocation emits an `approval.requested` event carrying the
 * summary (dataflow sources, counterparty, amount, residue provenance) and
 * blocks until an approver settles it through the API, or the TTL expires
 * (fail-closed → cancelled). Settlement emits `approval.granted` /
 * `approval.cancelled`.
 */

import type { AuditIdentifiers, HarnessEvent } from '@mazi/core';
import { authz } from '@mazi/core';

import { newHarnessEvent } from '../events/index.js';

export interface PendingApproval {
    invocationId: string;
    tool: string;
    capability: string;
    summary: string;
    echo: authz.ApprovalEcho;
    /** 允许的作用域；高危命令只有 once，UI 据此隐藏其余按钮。 */
    allowedScopes: readonly authz.ApprovalScope[];
    identifiers: AuditIdentifiers;
    requestedAt: number;
}

/** 结算来源：人工响应 / TTL 超时 / 停机关闭。 */
export type ApprovalSettler = 'user' | 'timeout' | 'shutdown';

export type ApprovalSettlement =
    | { decision: 'granted'; scope: 'once' | 'session' | 'workspace' }
    | { decision: 'rejected'; reason?: string }
    | { decision: 'cancelled' };

export interface ApprovalBrokerOptions {
    /** Event sink (the runtime bus) used for approval.requested/granted/cancelled. */
    emit: (event: HarnessEvent) => void;
    /** TTL before an unanswered request is cancelled (fail-closed). */
    timeoutMs?: number;
    now?: () => number;
}

interface Waiter {
    pending: PendingApproval;
    resolve: (decision: authz.ApprovalDecision) => void;
    timer: ReturnType<typeof setTimeout>;
}

export const DEFAULT_APPROVAL_TTL_MS = 5 * 60 * 1000;

export class ApprovalBroker implements authz.ApprovalSeam {
    private readonly waiters = new Map<string, Waiter>();
    private readonly timeoutMs: number;
    private readonly now: () => number;
    private readonly emit: (event: HarnessEvent) => void;

    constructor(opts: ApprovalBrokerOptions) {
        this.emit = opts.emit;
        this.timeoutMs = opts.timeoutMs ?? DEFAULT_APPROVAL_TTL_MS;
        this.now = opts.now ?? (() => Date.now());
    }

    decide(request: authz.ApprovalRequest): Promise<authz.ApprovalDecision> {
        const { invocationId, identifiers } = request;
        return new Promise<authz.ApprovalDecision>((resolve) => {
            const pending: PendingApproval = {
                invocationId,
                tool: request.tool,
                capability: request.capability,
                summary: authz.summarizeEcho(request.echo),
                echo: request.echo,
                allowedScopes: request.allowedScopes,
                identifiers,
                requestedAt: this.now(),
            };
            const timer = setTimeout(
                () => this.settle(invocationId, { decision: 'cancelled' }, 'timeout'),
                this.timeoutMs,
            );
            this.waiters.set(invocationId, { pending, resolve, timer });
            this.emitEvent('approval.requested', identifiers, request.capability, pending);
        });
    }

    pending(): PendingApproval[] {
        return [...this.waiters.values()].map((waiter) => waiter.pending);
    }

    /**
     * 结算一条待审：
     * @param by 结算来源——`user` 人工响应；`timeout` TTL 到期；`shutdown` 停机关闭。
     *   行为流只把 `user` 记为授权行为（见 docs/用户行为流设计文档.md §10.5）。
     */
    settle(
        invocationId: string,
        settlement: ApprovalSettlement,
        by: ApprovalSettler = 'user',
    ): boolean {
        const waiter = this.waiters.get(invocationId);
        if (!waiter) return false;
        clearTimeout(waiter.timer);
        this.waiters.delete(invocationId);

        const decision: authz.ApprovalDecision =
            settlement.decision === 'granted'
                ? { decision: 'granted', scope: settlement.scope }
                : settlement.decision === 'rejected'
                  ? { decision: 'rejected', reason: settlement.reason ?? '审批拒绝' }
                  : { decision: 'cancelled' };
        waiter.resolve(decision);

        const latencyMs = Math.max(0, this.now() - waiter.pending.requestedAt);
        this.emitEvent(
            settlement.decision === 'granted' ? 'approval.granted' : 'approval.cancelled',
            waiter.pending.identifiers,
            waiter.pending.capability,
            {
                invocationId,
                ...settlement,
                ...(settlement.decision === 'granted' ? { scope: settlement.scope } : {}),
                by,
                latencyMs,
            },
        );
        return true;
    }

    cancelAll(): void {
        for (const invocationId of [...this.waiters.keys()]) {
            this.settle(invocationId, { decision: 'cancelled' }, 'shutdown');
        }
    }

    private emitEvent(
        type: HarnessEvent['type'],
        identifiers: AuditIdentifiers,
        capability: string,
        payload: unknown,
    ): void {
        this.emit(
            newHarnessEvent({
                type,
                rootGoalId: identifiers.rootGoalId,
                goalId: identifiers.goalId,
                taskId: identifiers.taskId,
                stepId: identifiers.stepId,
                attributes: { 'harness.approval_effect_class': capability },
                payload,
            }),
        );
    }
}
