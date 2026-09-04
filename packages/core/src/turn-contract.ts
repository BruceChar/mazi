import type { PermissionLevel, SideEffectScope } from './capacity';
import type { AcceptanceSpec, RollbackStrategy, TerminationSpec } from './goal';
import type { CapabilityTag, SpecialtyTag } from './provider';

/** 子任务回滚规格 */
export interface RollbackSpec {
    strategy: RollbackStrategy;
    description?: string;
}

/** 子任务契约（Turn 级声明） */
export interface TurnContract {
    turnContractId: string;
    parentGoalId: string;
    parentPlanNodeId: string;
    statement: string;
    /** 路由标签：Provider 选择的唯一信号源 */
    tags: TaskTag[];
    /** 机械可判定的子任务验收 */
    success: AcceptanceSpec;
    /** 失败信号：什么算失败 + 触发后的处理动作 */
    failureSignals: FailureSignal[];
    /** 工具需求（声明式；⊆ GoalContract.allowedTools） */
    requiredTools: ToolRequirement[];
    /** 本子任务权限上限（≤ permissionCeiling） */
    maxPermission: PermissionLevel;
    /** 预算切片 */
    budget: BudgetSlice;
    /** 预期可观察副作用（供 Observer 差异校验） */
    expectedSideEffects: SideEffectSpec[];
    rollback: RollbackSpec;
    /** 防 Turn 级死循环 */
    termination: TerminationSpec;
}

/** 路由任务标签：业务专长或硬能力 */
export type TaskTag = SpecialtyTag | CapabilityTag | (string & {});

/** 工具需求声明 */
export interface ToolRequirement {
    /** 'fs.write' | 'code-execution' | ... */
    nameOrCapability: string;
    /** required：装配缺失即 Turn 失败；optional：缺失时降级继续 */
    required: boolean;
}

/** Turn 失败信号及动作 */
export interface FailureSignal {
    kind:
        | 'tool-error'
        | 'acceptance-failed'
        | 'budget-exceeded'
        | 'timeout'
        | 'schema-violation'
        | 'approval-denied'
        | (string & {});
    /** 匹配条件，如 { tool:'browser', statusCode:429 } */
    when?: Record<string, unknown>;
    action: 'retry' | 'replan' | 'fallback-provider' | 'escalate-approval' | 'abort-turn';
    maxRetries?: number;
}

/** Turn 预算切片 */
export interface BudgetSlice {
    maxSteps?: number;
    maxTokens?: number;
    maxCostUsd?: number;
    timeoutMs?: number;
}

/** 预期副作用规格 */
export interface SideEffectSpec {
    scope: SideEffectScope;
    description?: string;
    reversible: boolean;
}
