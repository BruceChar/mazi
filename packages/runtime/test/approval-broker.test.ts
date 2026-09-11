import { describe, expect, it } from 'vitest';

import type { HarnessEvent } from '@mazi/core';

import { ApprovalBroker } from '../src/tool-gateway/approval.js';

function request(invocationId: string) {
    return {
        invocationId,
        tool: 'shell.run',
        capability: 'fs.exec',
        identifiers: { rootGoalId: 'rg', goalId: 'g', taskId: 't', stepId: 's' },
        echo: {
            invocationId,
            tool: 'shell.run',
            effectClass: 'fs.exec',
            dataflowSources: ['db.read'],
            derivedLabelProvenance: [],
        },
    };
}

describe('ApprovalBroker', () => {
    it('emits approval.requested and resolves on settle', async () => {
        const events: HarnessEvent[] = [];
        const broker = new ApprovalBroker({
            emit: (event) => events.push(event),
            timeoutMs: 1000,
            now: () => 100,
        });
        const promise = broker.decide(request('inv-1'));
        expect(broker.pending()).toHaveLength(1);
        expect(events[0].type).toBe('approval.requested');
        expect(events[0].payload).toMatchObject({ invocationId: 'inv-1' });

        expect(broker.settle('inv-1', { decision: 'granted', scope: 'session' })).toBe(true);
        await expect(promise).resolves.toEqual({ decision: 'granted', scope: 'session' });
        expect(events.map((event) => event.type)).toEqual([
            'approval.requested',
            'approval.granted',
        ]);
        expect(broker.pending()).toHaveLength(0);
    });

    it('fails closed on TTL expiry', async () => {
        const broker = new ApprovalBroker({ emit: () => {}, timeoutMs: 5 });
        await expect(broker.decide(request('inv-2'))).resolves.toEqual({ decision: 'cancelled' });
    });

    it('supports rejection and cancelAll', async () => {
        const events: HarnessEvent[] = [];
        const broker = new ApprovalBroker({ emit: (event) => events.push(event), timeoutMs: 1000 });
        const rejected = broker.decide(request('a'));
        broker.settle('a', { decision: 'rejected', reason: 'no' });
        await expect(rejected).resolves.toEqual({ decision: 'rejected', reason: 'no' });

        const cancelled = broker.decide(request('b'));
        broker.cancelAll();
        await expect(cancelled).resolves.toEqual({ decision: 'cancelled' });
        // rejection is surfaced as approval.cancelled (with decision: 'rejected')
        const cancelledEvents = events.filter((event) => event.type === 'approval.cancelled');
        expect(cancelledEvents).toHaveLength(2);
        expect(cancelledEvents[0].payload).toMatchObject({ decision: 'rejected', reason: 'no' });
    });

    it('returns false for an unknown invocation', () => {
        const broker = new ApprovalBroker({ emit: () => {} });
        expect(broker.settle('missing', { decision: 'cancelled' })).toBe(false);
    });
});
