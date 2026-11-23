import { describe, expect, it } from 'vitest';
import {
    createGoalContractDraft,
    LOOP_MODES,
    normalizeLoopMode,
    PERMISSION_LEVELS,
    toGoalContractPayload,
} from '../src/scripts/goal-contract.ts';

describe('GoalContract defaults', () => {
    it('exposes the supported permission ceilings and loop modes', () => {
        expect(PERMISSION_LEVELS).toContain('read-only');
        expect(LOOP_MODES.map((m) => m.value)).toEqual(['default', 'dynamic']);
    });

    it('旧 loop mode 归一为当前两种执行 loop', () => {
        expect(normalizeLoopMode('goal-plan-execute-reflect')).toBe('default');
        expect(normalizeLoopMode('goal-plan-execute')).toBe('default');
        expect(normalizeLoopMode('react-only')).toBe('dynamic');
        expect(normalizeLoopMode('dynamic')).toBe('dynamic');
        expect(normalizeLoopMode(undefined)).toBe('default');
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
