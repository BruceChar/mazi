import type { GoalContract } from '@mazi/core';
import { ulid } from '@mazi/core';
import type { RuntimeConfig } from './config';

/**
 * GoalFactory（应用层，不调用模型，MVP 文档 §5.1）：
 * 用户输入 + 运行时配置 → GoalContract（约束/工具域/权限/预算/终止）。
 */
export function buildGoal(
    sessionId: string,
    rawIntent: string,
    config: RuntimeConfig,
): GoalContract {
    const g = config.goal ?? {};
    const maxSteps = g.maxSteps ?? 8;
    const budget = {
        maxSteps,
        maxTokens: g.maxCostUsd !== undefined ? undefined : undefined,
        maxCostUsd: g.maxCostUsd,
        reserveRatio: 0.2,
    };
    void budget;
    const goal: GoalContract = {
        goalId: ulid(),
        sessionId,
        statement: rawIntent,
        success: {
            conditions: g.successConditions ?? [],
            description: '执行无错误且产出最终回答',
        },
        constraints: [],
        allowedTools: g.allowedTools ?? ['all-registry'],
        permissionCeiling: g.permissionCeiling ?? 'read-only',
        budget: {
            maxSteps,
            maxCostUsd: g.maxCostUsd,
            reserveRatio: 0.2,
        },
        termination: { maxSteps },
        rollbackPolicy: { strategy: 'none' },
        strategyHints: ['complex'],
        metadata: {
            requiredTools: g.requiredTools ?? [],
        },
    };
    return goal;
}
