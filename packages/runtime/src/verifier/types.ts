import type { AcceptanceResult, Goal } from '@mazi/core';
import type { TaskOutcome } from '../gts/goal-executor.js';

/** 契约机械检查的环境探针；verifier 透传给 evaluateAcceptance（判定仍保持纯函数）。 */
export type { ConditionEnvironment } from '../gts/acceptance.js';

export type VerificationState = 'passed' | 'failed' | 'uncertain';
export type VerificationFailureCategory =
    | 'model'
    | 'planning'
    | 'tool_selection'
    | 'tool_execution'
    | 'context'
    | 'memory'
    | 'policy'
    | 'environment'
    | 'system';

export interface SemanticJudgeRequest {
    goal: Goal;
    outcome: TaskOutcome;
    conditionId: string;
    condition: string;
    evidence: readonly string[];
}

export interface SemanticJudgeVerdict {
    status: 'passed' | 'failed' | 'uncertain';
    confidence?: number;
    reason?: string;
}

export interface SemanticJudge {
    readonly id: string;
    readonly version?: string;
    judge(request: SemanticJudgeRequest): Promise<SemanticJudgeVerdict>;
}

export interface VerificationReport {
    verifierId: string;
    state: VerificationState;
    acceptance: AcceptanceResult;
    failureCategory?: VerificationFailureCategory;
    evidence: string[];
    semanticJudgeId?: string;
    checkedAt: number;
}

export interface TaskVerifier {
    readonly id: string;
    verify(goal: Goal, outcome: TaskOutcome): Promise<VerificationReport>;
}
