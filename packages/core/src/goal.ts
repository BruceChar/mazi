import type { PermissionLevel } from './capacity.js';

/** 整体/子任务验收规格 */
export interface AcceptanceSpec {
    /** 机械可判定条件，全部满足即成功 */
    conditions: string[];
    /** Goal 级跨 Turn 聚合条件 */
    aggregateConditions?: string[];
    /** 人类可读的成功标准说明 */
    description?: string;
}

/** Session 或 Turn 的终止条件 */
export interface TerminationSpec {
    maxTurns?: number;
    maxSteps?: number;
    maxCostUsd?: number;
    timeoutMs?: number;
    /** 自定义终止规则（机器可校验表达式） */
    conditions?: string[];
}

/** 回滚策略 */
export type RollbackStrategy = 'none' | 'manual' | 'automatic' | (string & {});

/** Goal 级整体回滚策略 */
export interface RollbackPolicy {
    strategy: RollbackStrategy;
    description?: string;
}

/** Session 级 GoalContract：全局约束与预算来源 */
export interface GoalContract {
    goalId: string;
    sessionId: string;
    statement: string;
    /** 整体验收：可含跨 Turn 聚合条件 */
    success: AcceptanceSpec;
    /** 全局硬约束：机器可校验，Policy Engine 执行时强制 */
    constraints: Constraint[];
    /** 可用工具域：TurnContract.requiredTools 的合法上限 */
    allowedTools: string[] | 'all-registry';
    /** 权限天花板：任何 Turn 不得超越 */
    permissionCeiling: PermissionLevel;
    /** 全局预算（切片来源） */
    budget: GlobalBudget;
    termination: TerminationSpec;
    rollbackPolicy: RollbackPolicy;
    /** 策略选择提示（仅供 Strategy 选择，不参与 Provider 路由） */
    strategyHints?: StrategyHint[];
    metadata?: Record<string, unknown>;
}

/** 全局预算 */
export interface GlobalBudget {
    maxTurns?: number;
    maxSteps?: number;
    maxTokens?: number;
    maxCostUsd?: number;
    timeoutMs?: number;
    /** 切片时保留该比例的预算应对重规划/重试（默认 0.2） */
    reserveRatio?: number;
}

/** 机器可校验的硬约束 */
export interface Constraint {
    kind: 'forbidden-resource' | 'data-boundary' | 'compliance' | 'network' | 'spend' | 'custom';
    /** 机器可校验的条件表达式 */
    rule: string;
    description?: string;
}

/** 策略选择提示 */
export type StrategyHint =
    | 'simple'
    | 'complex'
    | 'long-horizon'
    | 'realtime'
    | 'batch'
    | (string & {});
