/**
 * Exec 树的行筛选（纯函数，供 ExecStream.vue 与单测使用）。
 *
 * 最终回答（整条 run 最后一个带 answer 的 deliberation）由底部 Summary 展示，不单独成行；
 * 但同一 step 上的 reasoning（thinking）不能跟着被丢掉——确定性单轮收尾时，最终回答与
 * 推理恰好落在同一个 deliberation step 上。
 */

export interface DeliberationLike {
    kind: string;
    stepId: string;
    thinking?: string | null;
    answer?: string | null;
    content?: string | null;
}

export interface RowDecision {
    /** 是否渲染该 step 为一行。 */
    show: boolean;
    /** 回答已在 Summary，行内不重复展示 answer。 */
    suppressIntent: boolean;
}

export function deliberationRowDecision(
    step: DeliberationLike,
    lastAnswerId: string | null,
): RowDecision {
    if (step.kind !== 'deliberation') return { show: true, suppressIntent: false };
    if (step.stepId === lastAnswerId) {
        // 最终回答由 Summary 承载；仅当有推理时保留 reasoning 行，且不再重复 answer。
        return { show: Boolean(step.thinking), suppressIntent: true };
    }
    return {
        show: Boolean(step.thinking || step.answer || step.content),
        suppressIntent: false,
    };
}
