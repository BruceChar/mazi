import type { BudgetSlice, GlobalBudget, GoalContract } from '@mazi/core';

/** 冷启动/均分切片的单 Turn 预算绝对下限（美元） */
export const MIN_TURN_BUDGET_USD = 0.01;

/** 默认保留比例：应对重规划/重试的全局预算保留（v1.2 §3.2.1） */
export const DEFAULT_RESERVE_RATIO = 0.2;

export interface BudgetSliceInput {
    goalBudget: GlobalBudget;
    goalTermination?: { maxSteps?: number; timeoutMs?: number };
    turnCount: number;
    reserveRatio?: number;
    minTurnBudgetUsd?: number;
}

/**
 * 均分预算切片（MVP 静态兜底，v1.2 §4.3 simple 模式）：
 * 可分配 = maxCostUsd × (1 − reserveRatio)；每 Turn 均分并施加绝对下限。
 * 守恒约束：Σ slice ≤ 全局 × (1 − reserveRatio)（验收 A3）。
 */
export function equalBudgetSlices(input: BudgetSliceInput): BudgetSlice[] {
    const { goalBudget, turnCount, goalTermination } = input;
    if (turnCount <= 0) {
        return [];
    }
    const reserveRatio = input.reserveRatio ?? goalBudget.reserveRatio ?? DEFAULT_RESERVE_RATIO;
    const minTurn = input.minTurnBudgetUsd ?? MIN_TURN_BUDGET_USD;
    const allocatableUsd = allocatableBudgetUsd(goalBudget.maxCostUsd, reserveRatio);
    const slices: BudgetSlice[] = [];
    for (let i = 0; i < turnCount; i++) {
        const slice: BudgetSlice = {
            maxSteps: goalBudget.maxSteps,
            maxTokens: goalBudget.maxTokens,
            timeoutMs: goalBudget.timeoutMs ?? goalTermination?.timeoutMs,
        };
        if (allocatableUsd !== undefined) {
            slice.maxCostUsd = Math.max(allocatableUsd / turnCount, minTurn);
        }
        if (goalTermination?.maxSteps !== undefined) {
            slice.maxSteps = Math.min(
                slice.maxSteps ?? goalTermination.maxSteps,
                goalTermination.maxSteps,
            );
        }
        slices.push(slice);
    }
    return slices;
}

/** 可分配全局预算 = maxCostUsd × (1 − reserveRatio) */
export function allocatableBudgetUsd(
    maxCostUsd: number | undefined,
    reserveRatio: number,
): number | undefined {
    if (maxCostUsd === undefined) {
        return undefined;
    }
    return maxCostUsd * (1 - reserveRatio);
}

/**
 * 预算守恒校验：Σ slice.maxCostUsd ≤ 全局 × (1 − reserveRatio)（当全局有上限时）。
 * 返回违规描述；无违规返回空数组。
 */
export function validateBudgetConservation(goal: GoalContract, slices: BudgetSlice[]): string[] {
    const reserveRatio = goal.budget.reserveRatio ?? DEFAULT_RESERVE_RATIO;
    const cap = allocatableBudgetUsd(goal.budget.maxCostUsd, reserveRatio);
    if (cap === undefined) {
        return [];
    }
    const sum = slices.reduce((acc, s) => acc + (s.maxCostUsd ?? 0), 0);
    if (sum > cap + 1e-9) {
        return [`预算不守恒：Σ ${sum.toFixed(4)} > 可分配 ${cap.toFixed(4)}`];
    }
    return [];
}
