/**
 * ApprovalBroker — the human-in-the-loop ApprovalSeam (V18/T8).
 *
 * Each gated invocation emits an `approval.requested` event carrying the
 * signed-echo summary (dataflow sources, counterparty, amount, derived-label
 * provenance, generation attestation text) and blocks until an approver
 * settles it through the API, or the TTL expires (fail-closed → cancelled).
 * Settlement emits `approval.granted` / `approval.cancelled`.
 */

import type { AuditIdentifiers, HarnessEvent } from '@mazi/core';
import { authz } from '@mazi/core';

import { newHarnessEvent } from '../observability/index.js';

export interface PendingApproval {
    invocationId: string;
    tool: string;
    capability: string;
    summary: string;
    echo: authz.ApprovalEcho;
    identifiers: AuditIdentifiers;
    requestedAt: number;
}

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
                identifiers,
                requestedAt: this.now(),
            };
            const timer = setTimeout(
                () => this.settle(invocationId, { decision: 'cancelled' }),
                this.timeoutMs,
            );
            this.waiters.set(invocationId, { pending, resolve, timer });
            this.emitEvent('approval.requested', identifiers, request.capability, pending);
        });
    }

    pending(): PendingApproval[] {
        return [...this.waiters.values()].map((waiter) => waiter.pending);
    }

    settle(invocationId: string, settlement: ApprovalSettlement): boolean {
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

        this.emitEvent(
            settlement.decision === 'granted' ? 'approval.granted' : 'approval.cancelled',
            waiter.pending.identifiers,
            waiter.pending.capability,
            {
                invocationId,
                ...settlement,
                ...(settlement.decision === 'granted' ? { scope: settlement.scope } : {}),
            },
        );
        return true;
    }

    cancelAll(): void {
        for (const invocationId of [...this.waiters.keys()]) {
            this.settle(invocationId, { decision: 'cancelled' });
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
