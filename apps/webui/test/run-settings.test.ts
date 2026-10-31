import { describe, expect, it } from 'vitest';
import { goalFromRunSettings, runSettings, saveRunSettings } from '../src/scripts/run-settings.ts';

describe('run settings (global GoalContract defaults)', () => {
    it('starts from the documented defaults', () => {
        // 与执行器默认一致（50）：该值已真正写入契约，默认过小会截断复杂任务
        expect(runSettings.maxSteps).toBe(50);
        expect(runSettings.loopMode).toBe('goal-plan-execute-reflect');
    });

    it('applies partial updates in memory', () => {
        saveRunSettings({ maxSteps: 12, loopMode: 'react-only' });
        expect(runSettings.maxSteps).toBe(12);
        expect(runSettings.loopMode).toBe('react-only');
    });

    it('carries the per-workspace permission override onto the run payload', () => {
        saveRunSettings({ budgetUsd: 1.5, maxSteps: 20, loopMode: 'goal-plan-execute' });
        expect(goalFromRunSettings('hello', 'workspace-write')).toMatchObject({
            statement: 'hello',
            permissionCeiling: 'workspace-write',
            maxCostUsd: 1.5,
            maxSteps: 20,
            loopMode: 'goal-plan-execute',
        });
        // Without an override the GoalContract default applies (the backend then
        // falls back to the system grant if the field is absent).
        expect(goalFromRunSettings('hi').permissionCeiling).toBe('read-only');
    });
});
