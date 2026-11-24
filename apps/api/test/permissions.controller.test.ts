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

function controller(events: HarnessEvent[]) {
    const replay = vi.fn(() => events);
    const replaySession = vi.fn(() => events);
    const service = {
        harness: () => ({ eventBus: { replay, replaySession } }),
    } as unknown as ApiRuntimeService;
    return { controller: new PermissionsController(service), replay, replaySession };
}

describe('PermissionsController.audit', () => {
    const granted = makeEvent({
        eventId: 'e1',
        type: 'approval.granted',
        actor: 'human',
        payload: { tool: 'bash', code: 'user-approved' },
    });
    const denied = makeEvent({
        eventId: 'e2',
        type: 'policy.denied',
        actor: 'harness',
        payload: { tool: 'rm', detail: 'dangerous write' },
        attributes: { 'harness.gateway_stage': 'enforce' },
    });
    const auto = makeEvent({
        eventId: 'e3',
        type: 'policy.check',
        actor: 'model',
        payload: { tool: 'read' },
    });

    it('replays by rootGoalId and extracts audit records', () => {
        const { controller: c, replay, replaySession } = controller([granted, denied, auto]);
        const out = c.audit(undefined, undefined, undefined, undefined, undefined, 'root-1');
        expect(replay).toHaveBeenCalledWith('root-1');
        expect(replaySession).not.toHaveBeenCalled();
        expect(out.records).toHaveLength(3);
        expect(out.records[0]).toMatchObject({ actor: 'user', result: 'approved', tool: 'bash' });
        expect(out.records[1]).toMatchObject({ actor: 'agent', result: 'denied', tool: 'rm' });
        expect(out.records[2]).toMatchObject({ actor: 'agent', result: 'auto', tool: 'read' });
    });

    it('replays by sessionId when no rootGoalId is given', () => {
        const { controller: c, replay, replaySession } = controller([granted]);
        c.audit('sess-9', undefined, undefined, undefined, undefined, undefined);
        expect(replaySession).toHaveBeenCalledWith('sess-9');
        expect(replay).not.toHaveBeenCalled();
    });

    it('filters by actor, result, tool and keyword', () => {
        const { controller: c } = controller([granted, denied, auto]);
        expect(c.audit(undefined, 'agent', undefined, undefined, undefined, 'root-1').records).toHaveLength(
            2,
        );
        expect(c.audit(undefined, undefined, 'denied', undefined, undefined, 'root-1').records).toEqual([
            expect.objectContaining({ result: 'denied' }),
        ]);
        expect(c.audit(undefined, undefined, undefined, 'bash', undefined, 'root-1').records).toEqual([
            expect.objectContaining({ tool: 'bash' }),
        ]);
        expect(
            c.audit(undefined, undefined, undefined, undefined, 'dangerous', 'root-1').records,
        ).toEqual([expect.objectContaining({ result: 'denied' })]);
    });

    it('returns empty records when neither sessionId nor rootGoalId is provided', () => {
        const { controller: c, replay, replaySession } = controller([granted]);
        expect(c.audit().records).toEqual([]);
        expect(replay).not.toHaveBeenCalled();
        expect(replaySession).not.toHaveBeenCalled();
    });
});
