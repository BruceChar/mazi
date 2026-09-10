/**
 * GoalContract defaults shared by the composer and the NewSessionModal.
 *
 * Keeping the shape in one place avoids the previous drift where the modal and
 * the composer each carried their own copy of the permission/budget fields.
 */

export const PERMISSION_LEVELS = ['text', 'read-only', 'draft', 'approved', 'autonomous'] as const;

export const LOOP_MODES = [
    { value: 'goal-plan-execute-reflect', label: 'GPER · default' },
    { value: 'goal-plan-execute', label: 'Plan-Execute' },
    { value: 'react-only', label: 'React Only' },
] as const;

export interface GoalContractDraft {
    statement: string;
    /** Maps to `permissionCeiling` on the wire. */
    permission: string;
    /** Maps to `maxCostUsd` on the wire. */
    budgetUsd: number;
    maxSteps: number;
    userId: string;
    loopMode: string;
}

/** Build a fresh draft with the product defaults. */
export function createGoalContractDraft(): GoalContractDraft {
    return {
        statement: '',
        permission: 'read-only',
        budgetUsd: 0.5,
        maxSteps: 8,
        userId: '',
        loopMode: 'goal-plan-execute-reflect',
    };
}

/** Map a draft onto the GoalContract payload accepted by POST /api/sessions. */
export function toGoalContractPayload(draft: GoalContractDraft): Record<string, unknown> {
    return {
        permissionCeiling: draft.permission,
        maxCostUsd: draft.budgetUsd,
        maxSteps: draft.maxSteps,
        userId: draft.userId || undefined,
        loopMode: draft.loopMode,
    };
}
