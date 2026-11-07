/**
 * behavior-placement —— 行为行 → Step 时间窗归属（纯函数，供 ExecStream.vue 与单测）。
 *
 * 行为行集中在 run 末尾渲染会把审批/授权与它真正阻塞的工具 Step 拆开。
 * 本模块按 Step 的时间窗把行为行就地挂到所属 Step 上：
 * 审批/授权发生在 gated tool Step 的 [startedAt, endedAt) 内，因此先展示授权、
 * 再展示该工具的结果；run 结束后的反馈没有归属，进 trailing 渲染在最后。
 */

import type { BehaviorRow } from './behavior-rows.ts';

/** Step 归属所需的最小时间窗（StepView / ExecStream 的任务/步骤行均可满足）。 */
export interface StepWindow {
    stepId: string;
    startedAt: number;
    endedAt?: number | null;
    status?: string;
}

/** 归属结果：每个 Step 带上落在其窗口内的行为行，未归属的行为行进 trailing。 */
export interface PlacedBehaviors<T extends StepWindow> {
    steps: Array<{ step: T; behaviors: BehaviorRow[] }>;
    trailing: BehaviorRow[];
}

interface Window {
    start: number;
    end: number;
    status?: string;
}

/**
 * Candidate priority (higher wins). A single model round can schedule several
 * pending invocation steps whose windows are all open (endedAt === null): the
 * approval happens while the active/running step executes, so that step wins.
 * Finished steps (finite endedAt) beat open/pending windows; startedAt is the
 * final tie-breaker.
 */
function rankOf(window: Window): number {
    if (window.status === 'active' || window.status === 'running') return 2;
    if (Number.isFinite(window.end)) return 1;
    return 0;
}

/**
 * Place behavior rows onto the Step whose time window contains them.
 *
 * Rules:
 * - A row belongs to a Step when `at` ∈ [startedAt, endedAt ?? +∞).
 * - Multiple matches are ranked: active/running Step first, then a Step with a
 *   finite endedAt, then the greatest startedAt (ties prefer the later Step in
 *   input order). This keeps approvals on the step waiting for authorization
 *   even when the same round pre-scheduled several pending steps.
 * - `endedAt` null/undefined means the Step is still open (pending/active).
 * - Rows that match no Step go to `trailing` (e.g. feedback after the run).
 * - Rows keep their input order within a Step; inputs are never mutated.
 */
export function placeBehaviors<T extends StepWindow>(
    steps: readonly T[],
    behaviors: readonly BehaviorRow[],
): PlacedBehaviors<T> {
    const windows: Window[] = steps.map((step) => ({
        start: step.startedAt,
        end: step.endedAt ?? Number.POSITIVE_INFINITY,
        status: step.status,
    }));
    const groups: Array<{ step: T; behaviors: BehaviorRow[] }> = steps.map((step) => ({
        step,
        behaviors: [],
    }));
    const trailing: BehaviorRow[] = [];

    for (const behavior of behaviors) {
        let target = -1;
        for (let index = 0; index < windows.length; index += 1) {
            const window = windows[index];
            if (window === undefined) continue;
            if (behavior.at < window.start || behavior.at >= window.end) continue;
            const targetWindow = target >= 0 ? windows[target] : undefined;
            const rank = rankOf(window);
            const targetRank = targetWindow === undefined ? -1 : rankOf(targetWindow);
            if (
                targetWindow === undefined ||
                rank > targetRank ||
                (rank === targetRank && window.start >= targetWindow.start)
            ) {
                target = index;
            }
        }
        const group = target >= 0 ? groups[target] : undefined;
        if (group) {
            group.behaviors.push(behavior);
        } else {
            trailing.push(behavior);
        }
    }

    return { steps: groups, trailing };
}
