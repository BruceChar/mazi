import { describe, expect, it } from 'vitest';
import {
    createGoalContractDraft,
    LOOP_MODES,
    PERMISSION_LEVELS,
    toGoalContractPayload,
} from '../src/scripts/goal-contract.ts';

describe('GoalContract defaults', () => {
    it('exposes the supported permission ceilings and loop modes', () => {
        expect(PERMISSION_LEVELS).toContain('read-only');
        expect(LOOP_MODES.map((m) => m.value)).toContain('goal-plan-execute-reflect');
    });

    it('creates a fresh draft with the documented defaults', () => {
        const draft = createGoalContractDraft();
        expect(draft).toMatchObject({ permission: 'read-only', budgetUsd: 0.5, maxSteps: 8 });
    });

    it('maps the draft onto the wire payload (empty userId becomes undefined)', () => {
        const payload = toGoalContractPayload({
            ...createGoalContractDraft(),
            statement: 'hello',
            userId: '',
        });
        expect(payload.permissionCeiling).toBe('read-only');
        expect(payload.maxCostUsd).toBe(0.5);
        expect(payload.userId).toBeUndefined();
    });
});
