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

/** Live step shape (subset of store LiveStep) needed to render its body. */
export interface LiveStepBodyLike {
    kind: string;
    thinking?: string | null;
    answer?: string | null;
    output?: string | null;
}

/** Body slots of one live step; an empty string means "nothing in this slot". */
export interface LiveStepBodies {
    thinking: string;
    answer: string;
    output: string;
}

/**
 * Split a live step into the body slots rendered while the run streams:
 * deliberation shows thinking + answer, invocation shows the tool output.
 * Fields belonging to another kind are ignored so tool output never leaks
 * into a deliberation row (and vice versa).
 */
export function liveStepBodies(step: LiveStepBodyLike): LiveStepBodies {
    if (step.kind === 'deliberation') {
        return { thinking: step.thinking ?? '', answer: step.answer ?? '', output: '' };
    }
    if (step.kind === 'invocation') {
        return { thinking: '', answer: '', output: step.output ?? '' };
    }
    return { thinking: '', answer: '', output: '' };
}

/**
 * Toggle one row key in a collapse set. Returns a new Set so Vue refs observe
 * the change; the input set is never mutated.
 */
export function toggleCollapsedKey(collapsed: ReadonlySet<string>, key: string): Set<string> {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
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
