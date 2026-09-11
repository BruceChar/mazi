import { describe, expect, it } from 'vitest';
import { goalFromRunSettings, runSettings, saveRunSettings } from '../src/scripts/run-settings.ts';

describe('run settings (global GoalContract defaults)', () => {
    it('starts from the documented defaults', () => {
        expect(runSettings.maxSteps).toBe(8);
        expect(runSettings.loopMode).toBe('goal-plan-execute-reflect');
    });

    it('applies partial updates in memory', () => {
        saveRunSettings({ maxSteps: 12, loopMode: 'react-only' });
        expect(runSettings.maxSteps).toBe(12);
        expect(runSettings.loopMode).toBe('react-only');
    });

    it('maps the current defaults onto a new run payload (no per-run permission)', () => {
        saveRunSettings({ budgetUsd: 1.5, maxSteps: 20, loopMode: 'goal-plan-execute' });
        const payload = goalFromRunSettings('hello');
        expect(payload).toMatchObject({
            statement: 'hello',
            maxCostUsd: 1.5,
            maxSteps: 20,
            loopMode: 'goal-plan-execute',
        });
        // The system grant governs; a run must not carry its own permissionCeiling.
        expect(payload.permissionCeiling).toBeUndefined();
    });
});
