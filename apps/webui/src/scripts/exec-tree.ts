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

interface GoalTaskFactsLike {
    startedAt?: number | null;
    steps?: readonly unknown[] | null;
}

/**
 * Goal 展示所需的最小事实：triage 判断 + harness 的 Task/Step 事实。
 * route 只是模型判断，不能单独用来压掉执行记录。
 */
export interface GoalDisplayFactsLike {
    negotiation?: { route?: string; directAnswer?: string | null } | null;
    tasks?: readonly GoalTaskFactsLike[] | null;
}

/** 是否存在已开始的 Task 或 Step；任一事实存在就必须展示执行树。 */
export function hasExecutionFacts(goal: GoalDisplayFactsLike | null | undefined): boolean {
    return (goal?.tasks ?? []).some(
        (task) => task.startedAt != null || (task.steps?.length ?? 0) > 0,
    );
}

/**
 * 是否可折叠为纯直答：route=direct、确有直答文本，且没有 harness 执行事实。
 * 历史数据里 direct 与 Task/Step 并存时以执行事实为准。
 */
export function isDirectAnswerOnly(goal: GoalDisplayFactsLike | null | undefined): boolean {
    const answer = goal?.negotiation?.directAnswer;
    return (
        goal?.negotiation?.route === 'direct' &&
        typeof answer === 'string' &&
        answer.trim().length > 0 &&
        !hasExecutionFacts(goal)
    );
}

/** 契约卡片是否展示：仅纯直答跳过，其余（含旧数据缺省）照常展示。 */
export function showContractCard(goal: GoalDisplayFactsLike | null | undefined): boolean {
    return !isDirectAnswerOnly(goal);
}
