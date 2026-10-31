/**
 * acceptance —— 验收评估器（actor 之外的判定角色，裁决 D8）。
 *
 * 纯函数：goal.contract.successConditions × TaskOutcome → AcceptanceResult。
 * 只判 ConditionCheck 声明的机械形状；语义条款 / 无 check 的确定性条款一律标
 * unchecked（不冒充通过），交后续 judge 或人工补判。
 */

import type { AcceptanceResult, CheckableCondition, ConditionResult, Goal } from '@mazi/core';
import type { TaskOutcome } from './goal-executor.js';

const UNCHECKED_DETAIL = '无机械检查器（语义条款或缺省 check）';

/** 契约满足度的机械口径（Goal 级汇总；评估器角色产出，非 executor 自述）。 */
export type ContractState = 'satisfied' | 'violated' | 'partial' | 'unchecked';

export interface ContractEvaluation {
    state: ContractState;
    /** 契约条款总数 */
    total: number;
    /** 已机械判定的条款数 */
    evaluated: number;
    passed: number;
    failed: number;
}

/**
 * Goal 级汇总：把各 Task 的条款判定按「failed 优先」合并，再对契约条款清单求值。
 * - violated：任一条款 failed，或任一 Task 的机械验收未通过；
 * - satisfied：全部条款都已机械判定且通过；
 * - partial：部分条款已判定通过，其余需 judge；
 * - unchecked：没有任何条款被机械判定（全语义 / 无 Task）。
 */
export function rollupAcceptance(
    conditionIds: readonly string[],
    results: readonly (AcceptanceResult | undefined)[],
): ContractEvaluation {
    const statusById = new Map<string, 'passed' | 'failed' | 'unchecked'>();
    for (const result of results) {
        for (const item of result?.conditions ?? []) {
            const current = statusById.get(item.conditionId);
            if (current === undefined || (current !== 'failed' && item.status === 'failed')) {
                statusById.set(item.conditionId, item.status);
            } else if (item.status === 'passed' && current === 'unchecked') {
                statusById.set(item.conditionId, 'passed');
            }
        }
    }
    let passed = 0;
    let failed = 0;
    let evaluated = 0;
    for (const id of conditionIds) {
        const status = statusById.get(id) ?? 'unchecked';
        if (status === 'failed') failed += 1;
        else if (status === 'passed') passed += 1;
        if (status !== 'unchecked') evaluated += 1;
    }
    const taskFailed = results.some((result) => result !== undefined && !result.passed);
    const total = conditionIds.length;
    const state: ContractState =
        failed > 0 || taskFailed
            ? 'violated'
            : total > 0 && evaluated === total
              ? 'satisfied'
              : evaluated > 0
                ? 'partial'
                : 'unchecked';
    return { state, total, evaluated, passed, failed };
}

function judge(condition: CheckableCondition, outcome: TaskOutcome): ConditionResult {
    if (condition.checkType !== 'deterministic' || condition.check === undefined) {
        return { conditionId: condition.id, status: 'unchecked', detail: UNCHECKED_DETAIL };
    }
    const check = condition.check;
    if (check.kind === 'final-answer') {
        const passed = outcome.ok && outcome.reason === 'final-answer';
        return {
            conditionId: condition.id,
            status: passed ? 'passed' : 'failed',
            detail: `executor:${outcome.reason}`,
        };
    }
    // check.kind === 'no-failed-steps'
    const failedSteps = outcome.steps.filter(
        (step) => step.status === 'failed' || step.status === 'error' || step.status === 'blocked',
    ).length;
    return {
        conditionId: condition.id,
        status: failedSteps === 0 ? 'passed' : 'failed',
        detail: failedSteps === 0 ? '无失败 Step' : `失败 Step ${failedSteps} 个`,
    };
}

/**
 * 对一次 Task 执行结果做机械验收判定并返回事实（不写存储；由编排层落库）。
 * - 语义条款 / 未配置 check 的确定性条款 → unchecked，不计入 evaluated；
 * - 任一条款 failed → passed=false；Task 本身失败也 → passed=false。
 */
export function evaluateAcceptance(
    goal: Goal,
    outcome: TaskOutcome,
    now: () => number = Date.now,
): AcceptanceResult {
    const selected = new Set(
        outcome.task.acceptance.conditions.length > 0
            ? outcome.task.acceptance.conditions
            : goal.contract.successConditions.map((condition) => condition.id),
    );
    const conditions = goal.contract.successConditions
        .filter((condition) => selected.has(condition.id))
        .map((condition) => judge(condition, outcome));
    const evaluated = conditions.filter((item) => item.status !== 'unchecked').length;
    return {
        checkedAt: now(),
        passed: outcome.ok && conditions.every((item) => item.status !== 'failed'),
        evaluated,
        total: conditions.length,
        conditions,
    };
}
