/**
 * goal-task-step —— 会话观测分层指标（docs/core/AHF_CORE_GTS.md 实现载体）。
 *
 * Goal(意图归因) / Task(目标归因) / Step(动作归因)
 *
 * 与旧模型映射（C1）：
 *   Session(rawIntent+goal) → root Goal(intake) + work Goal(statement)
 *   Turn  → Task（验收唯一锚定 Goal 契约，裁决 D3）
 *   Step  → Step（归属从 turnId/sessionId 改为 taskId/goalId + rootGoalId 派生）
 *   GoalContract(allowedTools/permissionCeiling/budget/termination…) 由旧字段语义
 *   收敛为 success/failure 机械条件 + 资源/预算/终止/风险（许可与工具模块另卷）。
 */

import type { PermissionLevel } from './authorization.js';
import { ULID } from './id.js';

export type OriginKind = 'human' | 'agent' | 'system';
export type GoalStatus = 'active' | 'succeeded' | 'failed' | 'aborted' | 'timeout';

/** 原始载荷：原料完整保存（多意图切分输入；根 Goal 持有） */
export interface RawPayload {
    contentType: 'text' | 'structured' | 'event';
    content: string | Record<string, unknown>;
    receivedAt: number;
}

/** parent 引用（Delegation 实体解散后的坍缩形态，裁决 D6/D7） */
export type GoalParent =
    | { type: 'split'; goalId: ULID }
    | { type: 'delegation'; goalId: ULID; taskId?: ULID; stepId: ULID };

/** 机器可判验收条款（checkType='semantic' 占比是健康度指标，裁决 D8） */
export interface CheckableCondition {
    id: ULID;
    checkType: 'deterministic' | 'semantic';
    description?: string;
}

/** 禁止触碰资源模式（许可模块细化；本处占位保持契约可编译） */
export interface ResourcePattern {
    kind: 'fs-glob' | 'net-host' | 'db-pattern' | 'command-pattern' | (string & {});
    pattern: string;
}

/** 预算分配（Goal 树法律 2 的载体） */
export interface BudgetAllocation {
    maxTokens?: number;
    maxCostUsd?: number;
    maxSteps?: number;
    maxTurns?: number;
    timeoutMs?: number;
    /** 切片保留比例（重规划/重试） */
    reserveRatio?: number;
}

export interface TerminationPolicy {
    maxTurns?: number;
    maxSteps?: number;
    maxCostUsd?: number;
    timeoutMs?: number;
}

export interface RiskProfile {
    hasIrreversibleActions: boolean;
    touchesNetwork: boolean;
    touchesExternalApi: boolean;
}

/** Goal 冻结契约：消费者是评估器/审批人/审计员，不是 actor（裁决 D8） */
export interface GoalContract {
    successConditions: CheckableCondition[];
    failureConditions: CheckableCondition[];
    forbiddenResources: ResourcePattern[];
    budget: BudgetAllocation;
    terminationPolicy: TerminationPolicy;
    riskProfile: RiskProfile;
}

export interface Goal {
    goalId: ULID;
    /** 沿 parent 链最顶层（根自身 = goalId）；A/B 锚点与法律 1 终点 */
    rootGoalId: ULID;
    parent?: GoalParent;
    /** 根 Goal 必填（origin.kind ∈ human|agent|system 均可作根来源；法律 1 终点允许 agent 委托根由上游 parent 铐链） */
    origin?: { kind: OriginKind };
    rawPayload?: RawPayload;
    /** 模型对 rawPayload 中本 Goal 所指意图片段的转写（裁决 D7） */
    statement: string;
    sourceSpan?: { start: number; end: number } | { jsonPointer: string };
    /** intake = 承载切分的系统 Goal；work = 实际工作 Goal */
    kind: 'intake' | 'work';
    contract: GoalContract;
    permissionCeiling: PermissionLevel;
    budget: BudgetAllocation;
    status: GoalStatus;
    createdAt: number;
    endedAt?: number;
}

/** 任务验收锚定 Goal 契约的条款（复用旧 AcceptanceSpec 同构形状，独立于旧模块） */
export interface AcceptanceSpec {
    conditions: string[];
    aggregateConditions?: string[];
    description?: string;
}

export interface Task {
    taskId: ULID;
    /** 唯一归属：验收锚定编译期强制（裁决 D3） */
    goalId: ULID;
    title: string;
    acceptance: AcceptanceSpec;
    status: 'pending' | 'running' | 'succeeded' | 'failed' | 'rolled_back';
    parentPlanNodeId?: string;
}

/** 归因原子（thinking|tool_call|observation 是决策链三环节，不可砍） */
export type StepKind = 'thinking' | 'intent' | 'tool_call' | 'observation';

export interface ThinkingPayload {
    content: string;
    contextContent?: string;
}

/** Model output / final intent — the answer produced after reasoning */
export interface IntentPayload {
    content: string;
    contextContent?: string;
}

export interface ToolCallPayload {
    toolName: string;
    arguments: Record<string, unknown>;
    callId?: string;
    /** Tool execution output (merged from former observation step) */
    output?: string;
    isError?: boolean;
    structured?: unknown;
}

export interface ObservationPayload {
    toolName?: string;
    content: string;
    contextContent?: string;
    isError?: boolean;
    structured?: Record<string, unknown>;
}

export type StepPayload = ThinkingPayload | IntentPayload | ToolCallPayload | ObservationPayload;

export interface HarnessError {
    code: string;
    message: string;
    /** 四源标签：model|tool|context|policy */
    source?: 'model' | 'tool' | 'context' | 'policy';
    retryable: boolean;
    cause?: unknown;
}

export interface Step {
    stepId: ULID;
    /** 归因：taskId 锚定 Task，goalId 锚定 Goal（rootGoalId 沿 parent 链派生） */
    taskId: ULID;
    goalId: ULID;
    kind: StepKind;
    payload: StepPayload;
    model?: { providerId: string; modelId: string };
    usage?: unknown;
    status: 'pending' | 'running' | 'ok' | 'error' | 'skipped' | 'blocked';
    error?: HarnessError;
    decisionContext?: { contextSummary: string; promptVersion?: string; capturedAt: number };
    startedAt: number;
    endedAt?: number;
}

// ============================================================
// 法律校验（纯函数，零 mock；docs/core/AHF_CORE_GOAL.md §6/§10）
// ============================================================

export type AttributionResult = { ok: true } | { ok: false; reason: string };

/** 法律 1：任何 Goal 沿 parent 边逐级回溯必须终止于有 origin.kind 的根；无孤儿动作 */
export function validateAttributionChain(goal: Goal, index: Map<string, Goal>): AttributionResult {
    const seen = new Set<string>();
    let current: Goal | undefined = goal;
    while (current !== undefined) {
        if (seen.has(current.goalId)) {
            return { ok: false, reason: `cycle at goal '${current.goalId}'` };
        }
        seen.add(current.goalId);
        const parent = current.parent;
        if (parent === undefined) {
            // 根：必须声明 origin（rawPayload 由根持有为软约束）
            if (current.origin === undefined) {
                return { ok: false, reason: `root goal '${current.goalId}' missing origin` };
            }
            return { ok: true };
        }
        const parentGoal = index.get(parent.goalId);
        if (parentGoal === undefined) {
            return {
                ok: false,
                reason: `goal '${current.goalId}' parent '${parent.goalId}' not found`,
            };
        }
        current = parentGoal;
    }
    return { ok: false, reason: 'unreachable' };
}

/** 法律 2：委托边 child.permissionCeiling ≤ 上游、child.budget ⊆ 上游预算；切分边兄弟预算和 ≤ parent 预算 */
export type CeilingCheck = { ok: true } | { ok: false; reason: string };

const PERMISSION_RANK: Record<PermissionLevel, number> = {
    text: 0,
    'read-only': 1,
    draft: 2,
    approved: 3,
    autonomous: 4,
};

function ceilingOk(child: PermissionLevel, parent: PermissionLevel): boolean {
    return (PERMISSION_RANK[child] ?? -1) <= (PERMISSION_RANK[parent] ?? -1);
}

function budgetWithin(child: BudgetAllocation, parent: BudgetAllocation): boolean {
    const costs = ['maxTokens', 'maxCostUsd', 'maxSteps', 'maxTurns', 'timeoutMs'] as const;
    return costs.every(
        (key) =>
            child[key] === undefined || parent[key] === undefined || child[key]! <= parent[key]!,
    );
}

export function validateCeilingMonotonicity(goals: Goal[], index: Map<string, Goal>): CeilingCheck {
    for (const goal of goals) {
        const parent = goal.parent;
        if (parent === undefined) continue;
        const parentGoal = index.get(parent.goalId);
        if (parentGoal === undefined) {
            return { ok: false, reason: `goal '${goal.goalId}' parent not found` };
        }
        if (!ceilingOk(goal.permissionCeiling, parentGoal.permissionCeiling)) {
            return {
                ok: false,
                reason: `goal '${goal.goalId}' ceiling '${goal.permissionCeiling}' exceeds parent '${parentGoal.permissionCeiling}'`,
            };
        }
        if (parent.type === 'split' && !budgetWithin(goal.budget, parentGoal.budget)) {
            return {
                ok: false,
                reason: `split goal '${goal.goalId}' budget exceeds parent intake budget`,
            };
        }
    }
    return { ok: true };
}
