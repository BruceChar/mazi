import { describe, expect, it } from 'vitest';

import type { ApprovalSettlement, PendingApproval } from '@mazi/runtime';

import { ApprovalsController } from '../src/approvals/approvals.controller.js';
import type { ApiRuntimeService } from '../src/common/runtime.service.js';

function controller(options: { pending?: PendingApproval[]; settle?: boolean } = {}) {
    const settlements: Array<[string, ApprovalSettlement]> = [];
    const service = {
        pendingApprovals: () => options.pending ?? [],
        settleApproval: (id: string, settlement: ApprovalSettlement) => {
            settlements.push([id, settlement]);
            return options.settle ?? true;
        },
    } as unknown as ApiRuntimeService;
    return { controller: new ApprovalsController(service), settlements };
}

describe('ApprovalsController', () => {
    it('lists pending approvals', () => {
        const pending = [{ invocationId: 'i' }] as unknown as PendingApproval[];
        const { controller: c } = controller({ pending });
        expect(c.list()).toEqual({ approvals: pending });
    });

    it('settles with a valid granted scope', () => {
        const { controller: c, settlements } = controller();
        expect(c.settle('inv-1', { decision: 'granted', scope: 'session' })).toEqual({ ok: true });
        expect(settlements).toEqual([['inv-1', { decision: 'granted', scope: 'session' }]]);
    });

    it('rejects an invalid decision or scope with 400', () => {
        const { controller: c } = controller();
        expect(() => c.settle('inv-1', { decision: 'maybe' })).toThrowError(/decision 非法/);
        expect(() => c.settle('inv-1', { decision: 'granted', scope: 'forever' })).toThrowError(
            /scope/,
        );
    });

    it('returns 404 for an already-settled invocation', () => {
        const { controller: c } = controller({ settle: false });
        expect(() => c.settle('inv-1', { decision: 'cancelled' })).toThrowError(/不存在/);
    });
});
