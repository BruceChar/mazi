/**
 * GoalContract defaults shared by the composer and the NewSessionModal.
 *
 * The system permission grant lives in System Settings → General (persisted by
 * the backend in settings.json); a run does NOT carry a permissionCeiling, so
 * the backend applies the system grant.
 */

/**
 * System permission levels exposed by Settings → General. The backend accepts
 * the full set (text/read-only/draft/approved/autonomous); the UI narrows to
 * the three that matter to a user.
 */
export const PERMISSION_LEVELS = ['read-only', 'workspace-write', 'autonomous'] as const;

/** Display metadata for the permission selector. */
export const PERMISSION_META = {
    'read-only': { label: '只读', hint: '只能读；写文件/执行命令/联网需批准' },
    'workspace-write': { label: '工作区写', hint: '可读写工作区；执行命令/联网需批准' },
    autonomous: { label: '完全', hint: '全部免批准（secret 写入仍禁止）' },
    text: { label: '文本', hint: '纯对话，不提供工具' },
    draft: { label: '草稿', hint: '读写工作区 + 联网；执行命令需批准' },
    approved: { label: '审批', hint: '读写/联网免批准；执行命令需批准' },
};

export const LOOP_MODES = [
    { value: 'goal-plan-execute-reflect', label: 'GPER · default' },
    { value: 'goal-plan-execute', label: 'Plan-Execute' },
    { value: 'react-only', label: 'React Only' },
] as const;

export interface GoalContractDraft {
    statement: string;
    /** Per-workspace permission override; maps to `permissionCeiling` on the wire. */
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
