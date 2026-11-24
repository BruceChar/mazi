import { describe, expect, it, vi } from 'vitest';

import type { HarnessEvent } from '@mazi/core';

import { PermissionsController } from '../src/permissions/permissions.controller.js';
import type { ApiRuntimeService } from '../src/common/runtime.service.js';

function makeEvent(overrides: Partial<HarnessEvent>): HarnessEvent {
    return {
        eventId: overrides.eventId ?? 'evt-' + Math.random().toString(36).slice(2, 8),
        type: overrides.type ?? 'policy.check',
        timestamp: overrides.timestamp ?? Date.now(),
        rootGoalId: overrides.rootGoalId ?? 'root-1',
        attributes: overrides.attributes ?? {},
        actor: overrides.actor,
        payload: overrides.payload,
        ...(overrides.sessionId !== undefined ? { sessionId: overrides.sessionId } : {}),
        ...(overrides.goalId !== undefined ? { goalId: overrides.goalId } : {}),
        ...(overrides.stepId !== undefined ? { stepId: overrides.stepId } : {}),
    } as HarnessEvent;
}

function controller(
    events: HarnessEvent[],
    conversations: { runContext: (rootGoalId: string) => unknown } = {
        runContext: () => undefined,
    },
) {
    const replay = vi.fn(() => events);
    const replaySession = vi.fn(() => events);
    const replayAll = vi.fn(() => events);
    const service = {
        harness: () => ({ eventBus: { replay, replaySession, replayAll } }),
    } as unknown as ApiRuntimeService;
    return {
        controller: new PermissionsController(service, conversations as never),
        replay,
        replaySession,
        replayAll,
    };
}

describe('PermissionsController.audit', () => {
    const granted = makeEvent({
        eventId: 'e1',
        type: 'approval.granted',
        actor: 'human',
        rootGoalId: 'rootA',
        timestamp: 1000,
        payload: { tool: 'bash', code: 'user-approved' },
    });
    const denied = makeEvent({
        eventId: 'e2',
        type: 'policy.denied',
        actor: 'harness',
        rootGoalId: 'rootB',
        payload: { tool: 'rm', detail: 'dangerous write' },
        attributes: { 'harness.gateway_stage': 'enforce' },
    });
    const auto = makeEvent({
        eventId: 'e3',
        type: 'policy.check',
        actor: 'model',
        rootGoalId: 'rootA',
        timestamp: 5000,
        payload: { tool: 'read' },
    });

    const contexts = {
        rootA: { conversationId: 'C1', projectId: 'P1' },
        rootB: { conversationId: 'C2', projectId: 'P2' },
    };
    function withContext(events: HarnessEvent[]) {
        return controller(events, {
            runContext: (rootGoalId: string) => contexts[rootGoalId as keyof typeof contexts],
        });
    }

    it('extracts records and attaches conversationId/projectId via runContext', () => {
        const { controller: c, replayAll } = withContext([granted, denied, auto]);
        const out = c.audit();
        expect(replayAll).toHaveBeenCalled();
        expect(out.records).toHaveLength(3);
        const byId = Object.fromEntries(out.records.map((r) => [r.id, r]));
        expect(byId.e1).toMatchObject({
            actor: 'user',
            result: 'approved',
            tool: 'bash',
            conversationId: 'C1',
            projectId: 'P1',
        });
        expect(byId.e2).toMatchObject({
            actor: 'agent',
            result: 'denied',
            tool: 'rm',
            conversationId: 'C2',
            projectId: 'P2',
        });
        expect(byId.e3).toMatchObject({ actor: 'agent', result: 'auto', tool: 'read', projectId: 'P1' });
    });

    it('filters by rootGoalId (right-panel subset of the same source)', () => {
        const { controller: c } = withContext([granted, denied, auto]);
        expect(c.audit(undefined, undefined, undefined, undefined, undefined, 'rootB').records).toEqual([
            expect.objectContaining({ id: 'e2' }),
        ]);
    });

    it('filters by projectId and conversationId', () => {
        const { controller: c } = withContext([granted, denied, auto]);
        expect(c.audit(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'P1').records.map((r) => r.id)).toEqual(['e1', 'e3']);
        expect(c.audit(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'C2').records.map((r) => r.id)).toEqual(['e2']);
    });

    it('filters by actor, result, tool and keyword', () => {
        const { controller: c } = withContext([granted, denied, auto]);
        expect(c.audit(undefined, 'agent').records).toHaveLength(2);
        expect(c.audit(undefined, undefined, 'denied').records).toEqual([
            expect.objectContaining({ result: 'denied' }),
        ]);
        expect(c.audit(undefined, undefined, undefined, 'bash').records).toEqual([
            expect.objectContaining({ tool: 'bash' }),
        ]);
        expect(c.audit(undefined, undefined, undefined, undefined, 'dangerous').records).toEqual([
            expect.objectContaining({ result: 'denied' }),
        ]);
    });

    it('filters by inclusive time range from/to', () => {
        const { controller: c } = withContext([granted, auto]);
        expect(c.audit(undefined, undefined, undefined, undefined, undefined, undefined, 2000).records).toEqual([
            expect.objectContaining({ tool: 'read' }),
        ]);
        expect(
            c.audit(undefined, undefined, undefined, undefined, undefined, undefined, undefined, 4000)
                .records,
        ).toEqual([expect.objectContaining({ tool: 'bash' })]);
    });
});
