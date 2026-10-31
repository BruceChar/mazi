/**
 * goal-task-step —— 观测分层指标（docs/core/AHF_CORE_GTS.md 实现载体）。
 *
 * Goal(意图归因) / Task(目标归因) / Step(动作归因)
 *
 */

import type { PermissionLevel } from './authz/permissions.js';
import type { ToolCall } from './provider.js';
import type { ULID } from './ulid.js';

export type OriginKind = 'human' | 'agent' | 'system';
type Status = 'pending' | 'active' | 'succeeded' | 'blocked' | 'failed' | 'aborted' | 'timeout';
export type GoalStatus = Status;

/** 原始载荷 */
export interface RawPayload {
    contentType: 'text' | 'structured' | 'event';
    content: string | Record<string, unknown>;
    receivedAt: number;
}

/**
 * 条款级机械检查规格：由 actor 之外的评估器消费（裁决 D8）。
 * 只收录能被确定性代码判定的形状——语义判断必须标 checkType='semantic'，
 * 不给它一个假装的 check，避免把 judge 伪装成机械判定。
 */
export type ConditionCheck =
    /** Task 以最终回答收尾（executor outcome.reason === 'final-answer'） */
    | { kind: 'final-answer' }
    /** 该 Task 没有任何失败 Step */
    | { kind: 'no-failed-steps' };

/** 机器可判验收条款（checkType='semantic' 占比是健康度指标，裁决 D8） */
export interface CheckableCondition {
    id: ULID;
    checkType: 'deterministic' | 'semantic';
    description?: string;
    /** 确定性检查规格；缺省且 checkType='deterministic' = 尚无检查器（UI 标未评估） */
    check?: ConditionCheck;
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

/** 契约协商路线（goal-parser 模板的 block.route；fallback = 未接入解析模型时的保守默认） */
export type NegotiationRoute = 'direct' | 'confirmed' | 'negotiate' | 'escalate' | 'fallback';

/** 协商问题：模板要求每问必带默认路径（用户不回答就按默认冻结） */
export interface NegotiationQuestion {
    q: string;
    why?: string;
    default: string;
}

export interface NegotiationAnswer {
    q: string;
    answer: string;
    /** 用户采纳问题自带默认（未手写答案） */
    usedDefault?: boolean;
}

/**
 * 契约协商轨迹：随 Goal 落库，让 Trace 面板能重建
 * 「为什么冻结了这些条款、用户答复改了什么」。
 */
export interface GoalNegotiation {
    route: NegotiationRoute;
    /** parser = 模型 triage 结果；fallback = 无解析模型时的默认执行路径 */
    classifiedBy: 'parser' | 'fallback';
    triggers: string[];
    understanding?: string[];
    defaultPath?: string[];
    questions: NegotiationQuestion[];
    answers: NegotiationAnswer[];
    escalation?: string;
    directAnswer?: string;
    /** 契约修订次数：0 = 首次冻结，>0 = 协商答复后修订 */
    revision: number;
    /** 协商是否已有答复（blocked → active 的判据） */
    resolved: boolean;
    at: number;
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
    /** 契约协商轨迹（triage 结果 + 用户答复）；旧数据缺省 = 未经协商直接冻结 */
    negotiation?: GoalNegotiation;
}

/** 任务验收锚定 Goal 契约的条款（复用旧 AcceptanceSpec 同构形状，独立于旧模块） */
export interface AcceptanceSpec {
    conditions: string[];
    aggregateConditions?: string[];
    description?: string;
}

/** 单条款的机械判定结果 */
export interface ConditionResult {
    conditionId: ULID;
    /** unchecked = 无机械检查器（语义条款或未配置 check），需 judge/人工 */
    status: 'passed' | 'failed' | 'unchecked';
    detail?: string;
}

/**
 * 验收判定事实（评估器角色产出，随 Task 落库）：
 * 只陈述"机械判定"能判到什么，判不到的显式标 unchecked，不冒充成功。
 */
export interface AcceptanceResult {
    checkedAt: number;
    /** 无 failed 条款且 Task 本身 ok */
    passed: boolean;
    /** 已机械判定的条款数 / 全部条款数 */
    evaluated: number;
    total: number;
    conditions: ConditionResult[];
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
    /** Task-level DAG dependencies. Execution order is a topological order. */
    dependsOn?: ULID[];
    /** Permission ceiling inherited from the plan node; must not exceed the Goal ceiling. */
    permissionCeiling?: PermissionLevel;
    /** Task-level budget; siblings must not exceed the parent allocation. */
    budget?: BudgetAllocation;
    /** Tool names required by this node. The runtime validates them before execution. */
    requiredTools?: string[];
    /** Plan version that produced this Task. */
    planVersion?: number;
    /** 进入 active 的时间（executor 落库；旧数据缺省） */
    startedAt?: number;
    /** 进入终态的时间 */
    endedAt?: number;
    /** 验收判定事实（评估器写入；旧数据缺省） */
    acceptanceResult?: AcceptanceResult;
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
    /** 确定性收尾前的原始答案模板（含 {{result}} 占位符）；用于审计与回放 */
    answerTemplate?: string;
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
