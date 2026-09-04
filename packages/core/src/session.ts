import type { Capacity } from './capacity.js';
import type { FlagSnapshot } from './flags.js';
import type { GoalContract } from './goal.js';
import type { ModelRef } from './provider.js';
import type { TurnContract } from './turn-contract.js';
import type { Usage } from './usage.js';

/** Session 生命周期状态 */
export type SessionState =
    | 'initializing'
    | 'running'
    | 'paused'
    | 'succeeded'
    | 'failed'
    | 'aborted';

/** 用户的一次输入 = 一个 Session（聚合根） */
export interface Session {
    sessionId: string;
    userId?: string;
    rawIntent: string;
    /** 顶层契约（静态声明，生成后基本只读） */
    goal: GoalContract;
    strategyId: string;
    state: SessionState;
    /** Session 显式持有 Turn 实例（执行期由 Plan 层创建） */
    turns: Turn[];
    /** 聚合缓存：Turn 结束时由 usage aggregator 增量写入 */
    aggregate?: SessionAggregate;
    /** 会话级 Flag 快照（求值一次，全程冻结） */
    flagSnapshot: FlagSnapshot;
    createdAt: number;
    endedAt?: number;
    outcome?: 'success' | 'failed' | 'aborted' | 'timeout';
}

/** Session 级聚合指标 */
export interface SessionAggregate {
    totalTurns: number;
    succeededTurns: number;
    failedTurns: number;
    rolledBackTurns: number;
    totalSteps: number;
    totalTokens: TokenTotals;
    totalCostUsd: number;
    totalDurationMs: number;
    contextStrategyInvocations: {
        truncate: number;
        summarize: number;
        retrieve: number;
        compressObservation: number;
        cachePromptPrefix: number;
    };
}

/** Token 分类累计 */
export interface TokenTotals {
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
    reasoning: number;
}

/** 目标拆解出的一个子任务 = 一个 Turn */
export interface Turn {
    turnId: string;
    sessionId: string;
    /** 本 Turn 的任务契约（Plan 层产出，落盘持久化） */
    contract: TurnContract;
    /** 运行时由 Planner 从 contract 组装（请求 → 授权） */
    capacity?: Capacity;
    stepIds: string[];
    status: 'pending' | 'running' | 'succeeded' | 'failed' | 'rolled_back';
    attempt: number;
    /** 断点续传：执行到一半的 Turn 可从此恢复 */
    checkpoint?: TurnCheckpoint;
}

/** Turn 级 Checkpoint，用于断点续传 */
export interface TurnCheckpoint {
    lastCompletedStepSeq: number;
    pendingStepIds: string[];
    accumulatedUsage: TokenTotals;
    accumulatedCostUsd: number;
    savedAt: number;
}

/** 最小执行单元的种类 */
export type StepKind = 'thinking' | 'tool_call' | 'observation';

/** 最小执行单元 = 一个 Step */
export interface Step {
    stepId: string;
    turnId: string;
    sessionId: string;
    seq: number;
    kind: StepKind;
    payload: ThinkingPayload | ToolCallPayload | ObservationPayload;
    model?: ModelRef;
    /** 四段完整 Usage（thinking/tool_call step 均须挂载） */
    usage?: Usage;
    status: 'pending' | 'running' | 'ok' | 'error' | 'skipped' | 'blocked';
    error?: HarnessError;
    startedAt: number;
    endedAt?: number;
    /** 审计用：上下文摘要 + prompt 版本 */
    decisionContext?: DecisionContext;
}

/** thinking Step 的载荷 */
export interface ThinkingPayload {
    content: string;
}

/** tool_call Step 的载荷 */
export interface ToolCallPayload {
    toolName: string;
    arguments: Record<string, unknown>;
    callId?: string;
}

/** observation Step 的载荷（工具返回等外部事实） */
export interface ObservationPayload {
    toolName?: string;
    content: string;
    isError?: boolean;
}

/** Harness 统一错误结构 */
export interface HarnessError {
    code: string;
    message: string;
    retryable: boolean;
    cause?: unknown;
}

/** Step 决策依据快照 */
export interface DecisionContext {
    contextSummary: string;
    promptVersion?: string;
    tokenCount?: number;
    capturedAt: number;
}
