import type {
    RuntimeContextBreakdown,
    Session,
    SessionAggregate,
    Step,
    TokenTotals,
    Turn,
    VendorUsage,
} from '@mazi/core';

/** 全零的 TokenTotals（各分类初始值） */
export function emptyTokenTotals(): TokenTotals {
    return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, reasoning: 0 };
}

/** 合并两份 TokenTotals：逐分类相加，返回新对象（不修改入参） */
export function mergeTokenTotals(a: TokenTotals, b: TokenTotals): TokenTotals {
    return {
        input: a.input + b.input,
        output: a.output + b.output,
        cacheWrite: a.cacheWrite + b.cacheWrite,
        cacheRead: a.cacheRead + b.cacheRead,
        reasoning: a.reasoning + b.reasoning,
    };
}

/** 单个 Step 的 vendor 计数 → TokenTotals；Step 未挂 usage（非 LLM step）时全零 */
export function stepUsageToTokenTotals(step: Step): TokenTotals {
    const vendor = step.usage?.vendor;
    if (vendor === undefined) {
        return emptyTokenTotals();
    }
    return {
        input: vendor.inputTokens,
        output: vendor.outputTokens,
        cacheWrite: vendor.cacheCreationInputTokens ?? 0,
        cacheRead: vendor.cacheReadInputTokens ?? 0,
        reasoning: vendor.reasoningOutputTokens ?? 0,
    };
}

/** 聚合输入：Session + 各 turn 的执行记录（状态与 steps 由调用方在 turn 结束时提供） */
export interface SessionAggregateInput {
    session: Session;
    turns: { status: Turn['status']; steps: Step[] }[];
}

/**
 * 由 session 与各 turn 执行记录构建 SessionAggregate：
 * 累计 turn 状态计数 / steps / token / cost；duration = now - session.createdAt；
 * contextStrategyInvocations 计数恒 0（MVP 无压缩执行，§5.2）。
 */
export function buildSessionAggregate(input: SessionAggregateInput): SessionAggregate {
    const { session, turns } = input;
    let succeededTurns = 0;
    let failedTurns = 0;
    let rolledBackTurns = 0;
    let totalSteps = 0;
    let totalTokens = emptyTokenTotals();
    let totalCostUsd = 0;

    for (const turn of turns) {
        if (turn.status === 'succeeded') {
            succeededTurns += 1;
        } else if (turn.status === 'failed') {
            failedTurns += 1;
        } else if (turn.status === 'rolled_back') {
            rolledBackTurns += 1;
        }
        totalSteps += turn.steps.length;
        for (const step of turn.steps) {
            if (step.usage === undefined) {
                continue;
            }
            totalTokens = mergeTokenTotals(totalTokens, stepUsageToTokenTotals(step));
            totalCostUsd += step.usage.cost.totalCostUsd;
        }
    }

    return {
        totalTurns: turns.length,
        succeededTurns,
        failedTurns,
        rolledBackTurns,
        totalSteps,
        totalTokens,
        totalCostUsd,
        totalDurationMs: Date.now() - session.createdAt,
        contextStrategyInvocations: {
            truncate: 0,
            summarize: 0,
            retrieve: 0,
            compressObservation: 0,
            cachePromptPrefix: 0,
        },
    };
}

/**
 * 估算漂移回填：drift = |runtime.totalContextTokens − vendor.inputTokens|，
 * 写回 runtime.estimationDriftTokens 并返回 drift（调用方自行决定是否告警）。
 */
export function backfillDrift(runtime: RuntimeContextBreakdown, vendor: VendorUsage): number {
    const drift = Math.abs(runtime.totalContextTokens - vendor.inputTokens);
    runtime.estimationDriftTokens = drift;
    return drift;
}

/** 漂移是否超过 5% 阈值（严格大于；MVP 仅告警不自动切换 tokenizer，§5.2） */
export function isDriftExcessive(drift: number, total: number): boolean {
    return drift > total * 0.05;
}
