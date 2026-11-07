/**
 * Exec 树的行筛选与展示判定（纯函数，供 ExecStream.vue 与单测使用）。
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

/** 折叠判定的最小输入（行或 step 都满足）。 */
export interface StepCollapseLike {
    kind: string;
}

/**
 * 是否默认折叠正文：模型推理（deliberation 的 thinking）默认只留一行摘要，
 * 点击行首 toggle 才展开；工具调用（invocation）保持默认展开。
 */
export function stepDefaultCollapsed(row: StepCollapseLike): boolean {
    return row.kind === 'deliberation';
}

/** 只带协商轨迹的 Goal 形状（直答判定只依赖 route）。 */
export interface GoalRouteLike {
    negotiation?: { route?: string } | null;
}

/**
 * 是否直答路线（triage 直接作答，没有真实任务）：该 Goal 只展示直答内容，
 * 不展示契约卡片与任务块。
 */
export function isDirectRoute(goal: GoalRouteLike | null | undefined): boolean {
    return goal?.negotiation?.route === 'direct';
}

/** 契约卡片是否展示：直答路线跳过，其余（含旧数据缺省）照常展示。 */
export function showContractCard(goal: GoalRouteLike | null | undefined): boolean {
    return !isDirectRoute(goal);
}
