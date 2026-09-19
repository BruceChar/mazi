/**
 * run-control —— 执行中/可恢复状态到 composer 主按钮的纯决策。
 * 与 Vue 解耦便于单测（apps/webui/test/run-control.test.ts）。
 */

export type ComposerPrimaryAction = 'send' | 'stop';

/** 执行中主按钮为「停止」，否则为「发送」。 */
export function composerPrimaryAction(state: { busy: boolean }): ComposerPrimaryAction {
    return state.busy ? 'stop' : 'send';
}

/** 是否展示「继续」入口：空闲且当前 run 可恢复。 */
export function showResume(state: { busy: boolean; resumable: boolean }): boolean {
    return !state.busy && state.resumable;
}

/** 运行结果 reason 是否表示「被停止、可恢复」。 */
export function isAbortedReason(reason: string | null | undefined): boolean {
    return reason === 'aborted';
}

/**
 * 从 Goal 树快照判断是否可恢复：最新 Task 状态为 aborted。
 * 用于页面刷新/历史会话（内存中的 runOutcomes 已丢失）时的判定。
 */
export function snapshotResumable(
    snapshot: { goals?: Array<{ tasks?: Array<{ status?: string }> }> } | null | undefined,
): boolean {
    const tasks = (snapshot?.goals ?? []).flatMap((goal) => goal.tasks ?? []);
    return tasks[tasks.length - 1]?.status === 'aborted';
}
