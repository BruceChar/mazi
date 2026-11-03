import type { PermissionLevel } from '@mazi/core';

export type EvalDifficulty = 'simple' | 'medium' | 'hard' | 'long-horizon';
export type EvalRiskLevel = 'read-only' | 'workspace-write' | 'external' | 'irreversible';
export type FailureCategory =
    | 'model'
    | 'planning'
    | 'tool_selection'
    | 'tool_execution'
    | 'context'
    | 'memory'
    | 'policy'
    | 'environment'
    | 'system';

export interface EvalAcceptance {
    id: string;
    description: string;
    kind: 'deterministic' | 'semantic';
}

export interface EvalAcceptanceResult {
    checkedAt: number;
    passed: boolean;
    evaluated: number;
    total: number;
    conditions: Array<{
        conditionId: string;
        status: 'passed' | 'failed' | 'unchecked';
        detail?: string;
    }>;
}

export interface EvalTask {
    id: string;
    title: string;
    difficulty: EvalDifficulty;
    category: string;
    risk: EvalRiskLevel;
    input: string;
    allowedTools: string[];
    expectedTools?: string[];
    acceptance: EvalAcceptance[];
    budget?: {
        maxSteps?: number;
        maxCostUsd?: number;
    };
    projectFixture?: string;
    tags?: string[];
}

export interface EvalToolCall {
    toolName: string;
    ok: boolean;
    argumentValid?: boolean;
}

export interface EvalMemoryMetrics {
    recallAtK?: number;
    precision?: number;
    staleInjected?: number;
    crossProjectLeaks?: number;
}

export interface EvalObservation {
    ok: boolean;
    acceptance: EvalAcceptanceResult;
    steps: number;
    toolCalls: EvalToolCall[];
    interventions: number;
    replans: number;
    latencyMs: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    costUsd: number;
    promptTokens?: number;
    finalAnswer?: string;
    memory?: EvalMemoryMetrics;
    failureCategory?: FailureCategory;
    failureEvidence?: string[];
    error?: string;
}

export interface EvalExecutionContext {
    task: EvalTask;
    modelId?: string;
    promptPackId?: string;
    permissionCeiling?: PermissionLevel;
}

export type EvalTaskExecutor = (context: EvalExecutionContext) => Promise<EvalObservation>;

export interface EvalTaskResult {
    task: EvalTask;
    observation: EvalObservation;
    success: boolean;
    toolCallAccuracy: number;
    toolPrecision: number;
    toolRecall: number;
    intervention: boolean;
    totalTokens: number;
    failureCategory?: FailureCategory;
    failureEvidence: string[];
}

export interface EvalAggregate {
    tasks: number;
    successes: number;
    successRate: number;
    toolCallAccuracy: number;
    interventionRate: number;
    averageSteps: number;
    averageLatencyMs: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    averageTokens: number;
    averageCostUsd: number;
    memoryRecallAtK?: number;
    memoryPrecision?: number;
    staleInjectionCount: number;
    crossProjectLeakCount: number;
    failureCounts: Partial<Record<FailureCategory, number>>;
}

export interface EvalReport {
    generatedAt: number;
    overall: EvalAggregate;
    byDifficulty: Partial<Record<EvalDifficulty, EvalAggregate>>;
    results: EvalTaskResult[];
}
