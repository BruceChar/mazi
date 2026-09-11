/**
 * RuntimePolicyAuditSink — condenses the gateway's per-stage audit events into
 * one bus event per invocation.
 *
 * The 11-stage pipeline emits a decision event per stage; forwarding all of
 * them to the event bus floods the UI stream (and JSONL log) with 11 events per
 * tool call. This sink buffers the stages of one invocation (keyed by stepId)
 * and emits a single `policy.check` (allowed) or `policy.denied` (denied)
 * event whose payload still contains the full ordered stage list.
 */

import type { authz, HarnessEvent } from '@mazi/core';

import { newHarnessEvent } from '../observability/index.js';

export interface PolicyAuditOptions {
    emit: (event: HarnessEvent) => void;
}

export class RuntimePolicyAuditSink implements authz.GatewayAuditSink {
    private readonly buffers = new Map<string, authz.GatewayAuditEvent[]>();

    constructor(private readonly opts: PolicyAuditOptions) {}

    log(event: authz.GatewayAuditEvent): void {
        const key = event.identifiers.stepId;
        const buffer = this.buffers.get(key) ?? [];
        buffer.push(event);
        if (event.decision === 'denied' || event.stage === 'audit') {
            this.buffers.delete(key);
            this.flush(buffer);
            return;
        }
        this.buffers.set(key, buffer);
    }

    /** Flush any unterminated buffers (e.g. handler exception paths). */
    flushAll(): void {
        for (const [key, buffer] of this.buffers) {
            this.buffers.delete(key);
            this.flush(buffer);
        }
    }

    private flush(events: authz.GatewayAuditEvent[]): void {
        if (events.length === 0) return;
        const last = events[events.length - 1];
        const denied = events.find((event) => event.decision === 'denied');
        this.opts.emit(
            newHarnessEvent({
                type: denied ? 'policy.denied' : 'policy.check',
                rootGoalId: last.identifiers.rootGoalId,
                goalId: last.identifiers.goalId,
                taskId: last.identifiers.taskId,
                stepId: last.identifiers.stepId,
                attributes: {
                    'harness.gateway_stage': denied?.stage ?? last.stage,
                    ...(last.capability ? { 'harness.gateway_effect_class': last.capability } : {}),
                },
                payload: {
                    tool: last.tool,
                    stages: events.map((event) => ({
                        stage: event.stage,
                        decision: event.decision,
                        ...(event.detail ? { detail: event.detail } : {}),
                        ...(event.ruleId ? { ruleId: event.ruleId } : {}),
                    })),
                    ...(denied
                        ? {
                              code: denied.code,
                              detail: denied.detail,
                              ...(denied.ruleId ? { ruleId: denied.ruleId } : {}),
                          }
                        : {}),
                },
            }),
        );
    }
}
