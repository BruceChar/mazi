/**
 * goal-task-step —— 观测分层指标（docs/core/AHF_CORE_GTS.md 实现载体）。
 *
 * Goal(意图归因) / Task(目标归因) / Step(动作归因)
 *
 */

import type { ULID } from './ulid.js';
import type { PermissionLevel } from './permissions.js';
import type { ToolCall } from './provider.js';

export type OriginKind = 'human' | 'agent' | 'system';
type Status = 'pending' | 'active' | 'succeeded' | 'blocked' | 'failed' | 'aborted' | 'timeout';
export type GoalStatus = Status;

/** 原始载荷 */
export interface RawPayload {
    contentType: 'text' | 'structured' | 'event';
    content: string | Record<string, unknown>;
    receivedAt: number;
}

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
    /** 接收侧来源标记：user intent 直接产 Goal（本坐标系无树结构，Goal 相互独立） */
    origin?: { kind: OriginKind };
    rawPayload?: RawPayload;
    /** 模型对 rawPayload 中本 Goal 所指意图片段的转写（裁决 D7） */
    statement: string;
    sourceSpan?: { start: number; end: number } | { jsonPointer: string };
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

type TaskStatus = Status;

export interface Task {
    taskId: ULID;
    /** 唯一归属：验收锚定编译期强制（裁决 D3） */
    goalId: ULID;
    title: string;
    acceptance: AcceptanceSpec;
    status: TaskStatus;
    parentPlanNodeId?: string;
    /** 进入 active 的时间（executor 落库；旧数据缺省） */
    startedAt?: number;
    /** 进入终态的时间 */
    endedAt?: number;
}
/************************** STEP ********************************************/

export type StepKind =
    // LLM intrinsic：一次模型输出（推理 / 回答 / 提议的工具调用）
    | 'deliberation'
    // Extrinsic：一次对外部世界的实际调用（tool / http / shell 等）
    | 'invocation';

/** 模型一次输出的决策事实：推理、回答、提议的工具调用（三者可并存） */
export interface DeliberationPayload {
    thinking?: string;
    answer?: string;
    /** 模型本轮提议的工具调用；callId 与 InvocationPayload.callId 配对 */
    toolCalls?: ToolCall[];
}

/** harness 对外部世界的一次实际调用及其结果 */
export interface InvocationPayload {
    toolName: string;
    arguments: Record<string, unknown>;
    /** 与 DeliberationPayload.toolCalls[].callId 配对 */
    callId?: string;
    /** 工具实际执行的工作目录（展示/追溯） */
    cwd?: string;
    output?: string;
}

export type StepPayload = DeliberationPayload | InvocationPayload;

export interface StepError {
    code: string;
    message: string;
    /** 四源标签：model|tool|context|policy */
    source?: 'model' | 'tool' | 'context' | 'policy';
    retryable: boolean;
    cause?: unknown;
}

export type StepStatus = Status | 'error' | 'skipped';

interface StepBase {
    stepId: ULID;
    /** 归因：taskId 锚定 Task，goalId 锚定 Goal */
    taskId: ULID;
    goalId: ULID;
    model?: { providerId: string; modelId: string };
    usage?: unknown;
    status: StepStatus;
    error?: StepError;
    startedAt: number;
    endedAt?: number;
}

/** 归因原子：kind 是唯一判别式，payload 随 kind 自动收窄 */
export type Step = StepBase &
    (
        | { kind: 'deliberation'; payload: DeliberationPayload }
        | { kind: 'invocation'; payload: InvocationPayload }
    );

// ============================================================
// 法律校验（纯函数，零 mock；docs/core/AHF_CORE_GTS.md）
//
// 本坐标系为扁平模型（意图直接产 Goal，Goal 相互独立、无树结构）：
// 原「法律 1 归因链闭合」「法律 2 治理上限单调递减」随 rootGoalId/parent 移除
// （2026-09-17 变更，见 AHF_CORE_GTS.md §8）。
// 保留的锚点：Goal.contract（验收条款，审批可指认 { goalId, conditionId }）。
// ============================================================
