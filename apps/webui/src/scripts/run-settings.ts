import { reactive } from 'vue';
import {
    createGoalContractDraft,
    type GoalContractDraft,
    toGoalContractPayload,
} from './goal-contract.js';

/** localStorage key holding the global run defaults. */
const STORAGE_KEY = 'mazi.web.run-settings';

/** GoalContract fields that are configured globally (System Settings → Run defaults). */
export type RunSettings = Pick<
    GoalContractDraft,
    'permission' | 'budgetUsd' | 'maxSteps' | 'loopMode'
>;

function defaultRunSettings(): RunSettings {
    const draft = createGoalContractDraft();
    return {
        permission: draft.permission,
        budgetUsd: draft.budgetUsd,
        maxSteps: draft.maxSteps,
        loopMode: draft.loopMode,
    };
}

function readRunSettings(): RunSettings {
    const base = defaultRunSettings();
    if (typeof localStorage === 'undefined') return base;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return base;
        const parsed = JSON.parse(raw) as Partial<RunSettings>;
        return {
            permission: typeof parsed.permission === 'string' ? parsed.permission : base.permission,
            budgetUsd: typeof parsed.budgetUsd === 'number' ? parsed.budgetUsd : base.budgetUsd,
            maxSteps: typeof parsed.maxSteps === 'number' ? parsed.maxSteps : base.maxSteps,
            loopMode: typeof parsed.loopMode === 'string' ? parsed.loopMode : base.loopMode,
        };
    } catch {
        return base;
    }
}

/** Reactive global run defaults. */
export const runSettings = reactive<RunSettings>(readRunSettings());

/** Persist **and** apply a partial update to the run defaults. */
export function saveRunSettings(next: Partial<RunSettings>): void {
    Object.assign(runSettings, next);
    if (typeof localStorage === 'undefined') return;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(runSettings));
    } catch {
        // Storage can be unavailable (private mode); in-memory state still wins.
    }
}

/** Build the GoalContract payload for a new run from the global defaults. */
export function goalFromRunSettings(statement: string): Record<string, unknown> {
    const draft: GoalContractDraft = { ...createGoalContractDraft(), ...runSettings, statement };
    return { statement, ...toGoalContractPayload(draft) };
}
