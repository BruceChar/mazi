import { describe, expect, it } from 'vitest';
import { goalFromRunSettings, runSettings, saveRunSettings } from '../src/scripts/run-settings.ts';

describe('run settings (global GoalContract defaults)', () => {
    it('starts from the documented defaults', () => {
        expect(runSettings.permission).toBe('read-only');
        expect(runSettings.maxSteps).toBe(8);
    });

    it('applies partial updates in memory', () => {
        saveRunSettings({ maxSteps: 12, loopMode: 'react-only' });
        expect(runSettings.maxSteps).toBe(12);
        expect(runSettings.loopMode).toBe('react-only');
    });

    it('maps the current defaults onto a new run payload', () => {
        saveRunSettings({
            permission: 'draft',
            budgetUsd: 1.5,
            maxSteps: 20,
            loopMode: 'goal-plan-execute',
        });
        expect(goalFromRunSettings('hello')).toMatchObject({
            statement: 'hello',
            permissionCeiling: 'draft',
            maxCostUsd: 1.5,
            maxSteps: 20,
            loopMode: 'goal-plan-execute',
        });
    });
});
