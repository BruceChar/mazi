import { describe, expect, it } from 'vitest';

import type { authz, HarnessEvent } from '@mazi/core';

import { RuntimePolicyAuditSink } from '../src/tool-gateway/policy-audit.js';

const identifiers = { rootGoalId: 'rg', goalId: 'g', taskId: 't', stepId: 's' };

function event(
    stage: authz.GatewayStage,
    decision: authz.GatewayAuditEvent['decision'],
    extra: Partial<authz.GatewayAuditEvent> = {},
): authz.GatewayAuditEvent {
    return { stage, decision, identifiers, tool: 'x', ...extra };
}

describe('RuntimePolicyAuditSink', () => {
    it('condenses all stages of one invocation into a single policy.check', () => {
        const events: HarnessEvent[] = [];
        const sink = new RuntimePolicyAuditSink({ emit: (e) => events.push(e) });
        for (const stage of [
            'escalation-short-circuit',
            'supply-check',
            'hook-chain',
            'tier-dispatch',
        ] as const) {
            sink.log(event(stage, 'info'));
        }
        sink.log(event('audit', 'allowed'));
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe('policy.check');
        expect((events[0].payload as { stages: unknown[] }).stages).toHaveLength(5);
    });

    it('emits policy.denied immediately with the reject code', () => {
        const events: HarnessEvent[] = [];
        const sink = new RuntimePolicyAuditSink({ emit: (e) => events.push(e) });
        sink.log(event('supply-check', 'allowed'));
        sink.log(
            event('tier-dispatch', 'denied', {
                code: 'FORBIDDEN_BY_POLICY',
                detail: 'nope',
            }),
        );
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe('policy.denied');
        expect((events[0].payload as { code: string }).code).toBe('FORBIDDEN_BY_POLICY');
    });

    it('flushAll flushes an unterminated buffer', () => {
        const events: HarnessEvent[] = [];
        const sink = new RuntimePolicyAuditSink({ emit: (e) => events.push(e) });
        sink.log(event('execute', 'allowed'));
        expect(events).toHaveLength(0);
        sink.flushAll();
        expect(events).toHaveLength(1);
    });
});
