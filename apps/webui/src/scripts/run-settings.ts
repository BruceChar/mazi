import { reactive } from 'vue';
import {
    createGoalContractDraft,
    type GoalContractDraft,
    toGoalContractPayload,
} from './goal-contract.js';

/** localStorage key holding the global run defaults. */
const STORAGE_KEY = 'mazi.web.run-settings';

/** GoalContract fields configured globally (System Settings → Run defaults) + model defaults. */
export type RunSettings = Pick<GoalContractDraft, 'budgetUsd' | 'maxSteps' | 'loopMode'> & {
    /** 默认模型 id（空 = provider 默认）。 */
    model: string;
    /** 默认推理等级（off/low/medium/high）。 */
    reasoningLevel: string;
};

function defaultRunSettings(): RunSettings {
    const draft = createGoalContractDraft();
    return {
        budgetUsd: draft.budgetUsd,
        maxSteps: draft.maxSteps,
        loopMode: draft.loopMode,
        model: '',
        reasoningLevel: 'high',
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
            budgetUsd: typeof parsed.budgetUsd === 'number' ? parsed.budgetUsd : base.budgetUsd,
            maxSteps: typeof parsed.maxSteps === 'number' ? parsed.maxSteps : base.maxSteps,
            loopMode: typeof parsed.loopMode === 'string' ? parsed.loopMode : base.loopMode,
            model: typeof parsed.model === 'string' ? parsed.model : base.model,
            reasoningLevel:
                typeof parsed.reasoningLevel === 'string'
                    ? parsed.reasoningLevel
                    : base.reasoningLevel,
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

/**
 * Build the GoalContract payload for a new run from the global defaults.
 *
 * `permissionCeiling` is the **per-workspace/session** override from the
 * composer; when omitted the system grant (Settings → General) applies.
 */
export function goalFromRunSettings(
    statement: string,
    permissionCeiling?: string,
): Record<string, unknown> {
    const draft: GoalContractDraft = {
        ...createGoalContractDraft(),
        ...runSettings,
        statement,
        ...(permissionCeiling ? { permission: permissionCeiling } : {}),
    };
    return { statement, ...toGoalContractPayload(draft) };
}
