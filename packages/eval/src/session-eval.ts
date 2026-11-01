import type { HarnessEvent } from '@mazi/core';
import type { GoalRunResult, GoalTreeSnapshot } from '@mazi/runtime';
import type { FailureCategory } from './types.js';

export type SessionEvaluationStatus = 'success' | 'failed' | 'aborted' | 'unverified';
export type SessionEvaluationSource = 'session' | 'ab';

export interface SessionEvaluationRecord {
    evaluationId: string;
    rootGoalId: string;
    source: SessionEvaluationSource;
    title: string;
    status: SessionEvaluationStatus;
    success: boolean;
    startedAt: number;
    completedAt: number;
    latencyMs: number;
    projectId?: string;
    workspace?: string;
    userId?: string;
    conversationId?: string;
    experimentId?: string;
    arm?: string;
    modelId?: string;
    promptPackIds: string[];
    tasks: {
        total: number;
        succeeded: number;
        failed: number;
        aborted: number;
    };
    acceptance: {
        passed: number;
        failed: number;
        evaluated: number;
        total: number;
    };
    tools: {
        calls: number;
        succeeded: number;
        failed: number;
        blocked: number;
        successRate: number;
        duplicateCalls: number;
    };
    interventions: number;
    approvalsDenied: number;
    replans: number;
    steps: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    totalTokens: number;
    costUsd: number;
    failureCategory?: FailureCategory;
    failureCounts: Partial<Record<FailureCategory, number>>;
    failureEvidence: string[];
    finalAnswer?: string;
}

export interface SessionEvaluationInput {
    rootGoalId: string;
    snapshot: GoalTreeSnapshot;
    events: readonly HarnessEvent[];
    result?: GoalRunResult;
    source?: SessionEvaluationSource;
    title?: string;
    projectId?: string;
    workspace?: string;
    userId?: string;
    conversationId?: string;
    experimentId?: string;
    arm?: string;
}

function stableArguments(args: Record<string, unknown> | undefined): string {
    if (args === undefined) return '{}';
    return JSON.stringify(
        Object.fromEntries(Object.entries(args).sort(([left], [right]) => left.localeCompare(right))),
    );
}

function failureCategoryOfReason(reason: string): FailureCategory | undefined {
    if (reason === 'driver-error') return 'model';
    if (reason === 'blocked-tool' || reason === 'tool-error') return 'tool_execution';
    if (reason === 'max-steps' || reason === 'budget-exceeded') return 'planning';
    return undefined;
}

export function projectSessionEvaluation(input: SessionEvaluationInput): SessionEvaluationRecord {
    const tasks = input.snapshot.goals.flatMap((goal) => goal.tasks);
    const steps = tasks.flatMap((task) => task.steps);
    const invocations = steps.filter((step) => step.kind === 'invocation');
    const taskStatuses = tasks.map((task) => task.status);
    const aborted = taskStatuses.filter((status) => status === 'aborted').length;
    const succeeded = taskStatuses.filter((status) => status === 'succeeded').length;
    const failed = taskStatuses.filter((status) => status === 'failed').length;
    const acceptanceResults = tasks.flatMap((task) =>
        task.acceptanceResult === undefined ? [] : [task.acceptanceResult],
    );
    const acceptanceConditions = acceptanceResults.flatMap((result) => result.conditions);
    const acceptancePassed = acceptanceConditions.filter(
        (condition) => condition.status === 'passed',
    ).length;
    const acceptanceFailed = acceptanceConditions.filter(
        (condition) => condition.status === 'failed',
    ).length;
    const acceptanceEvaluated = acceptanceConditions.filter(
        (condition) => condition.status !== 'unchecked',
    ).length;
    const outboundCalls = new Map<string, number>();
    for (const step of invocations) {
        const key = `${step.toolName ?? 'unknown'}:${stableArguments(step.toolArguments)}`;
        outboundCalls.set(key, (outboundCalls.get(key) ?? 0) + 1);
    }
    const duplicateCalls = [...outboundCalls.values()].reduce(
        (sum, count) => sum + Math.max(0, count - 1),
        0,
    );
    const toolSucceeded = invocations.filter((step) => step.status === 'succeeded').length;
    const toolFailed = invocations.filter(
        (step) => step.status === 'failed' || step.status === 'error',
    ).length;
    const toolBlocked = invocations.filter((step) => step.status === 'blocked').length;
    const seenRounds = new Set<string>();
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    let costUsd = 0;
    let modelId: string | undefined;
    for (const step of steps) {
        modelId ??= step.usage?.raw?.modelId;
        if (step.usage === undefined) continue;
        const roundId = step.usage.roundId ?? step.stepId;
        if (seenRounds.has(roundId)) continue;
        seenRounds.add(roundId);
        inputTokens += step.usage.raw?.inputTokens ?? 0;
        outputTokens += step.usage.raw?.outputTokens ?? 0;
        cachedInputTokens += step.usage.raw?.cachedInputTokens ?? 0;
        costUsd += step.usage.cost?.totalCostUsd ?? 0;
    }
    const approvalEvents = input.events.filter((event) => event.type === 'approval.requested');
    const approvalsDenied = input.events.filter((event) => event.type === 'approval.denied').length;
    const replans = input.events.filter((event) => event.type === 'plan.revised').length;
    const superAgent = input.events.find((event) => event.type === 'superagent.decision');
    const promptPackIds =
        superAgent !== undefined &&
        Array.isArray((superAgent.payload as Record<string, unknown> | undefined)?.promptPackIds)
            ? ((superAgent.payload as Record<string, unknown>).promptPackIds as string[])
            : [];
    const failureCounts: Partial<Record<FailureCategory, number>> = {};
    const failureEvidence: string[] = [];
    for (const event of input.events) {
        if (event.type !== 'verification.completed') continue;
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        const category = payload.failureCategory;
        if (
            category === 'model' ||
            category === 'planning' ||
            category === 'tool_selection' ||
            category === 'tool_execution' ||
            category === 'context' ||
            category === 'memory' ||
            category === 'policy' ||
            category === 'environment' ||
            category === 'system'
        ) {
            failureCounts[category] = (failureCounts[category] ?? 0) + 1;
        }
        if (Array.isArray(payload.evidence)) {
            failureEvidence.push(
                ...payload.evidence.filter(
                    (item): item is string => typeof item === 'string',
                ),
            );
        }
    }
    for (const outcome of input.result?.tasks ?? []) {
        if (outcome.ok || outcome.reason === 'aborted') continue;
        const category = failureCategoryOfReason(outcome.reason);
        if (category !== undefined) failureCounts[category] = (failureCounts[category] ?? 0) + 1;
        if (outcome.errorMessage !== undefined) failureEvidence.push(outcome.errorMessage);
    }
    const primaryFailure = Object.entries(failureCounts).sort(
        (left, right) => right[1] - left[1],
    )[0]?.[0] as FailureCategory | undefined;
    const runOk =
        input.result?.ok ??
        (tasks.length > 0 &&
            tasks.every((task) => task.status === 'succeeded' || task.status === 'pending'));
    const status: SessionEvaluationStatus =
        aborted > 0
            ? 'aborted'
            : runOk && acceptanceFailed === 0
              ? acceptanceEvaluated > 0
                  ? 'success'
                  : 'unverified'
              : 'failed';
    const starts = steps
        .map((step) => step.startedAt)
        .filter((value): value is number => typeof value === 'number');
    const ends = steps
        .map((step) => step.endedAt)
        .filter((value): value is number => typeof value === 'number');
    const startedAt = starts.length > 0 ? Math.min(...starts) : Date.now();
    const completedAt = ends.length > 0 ? Math.max(...ends) : Date.now();
    const finalAnswer = input.result?.tasks.at(-1)?.finalMessage;
    return {
        evaluationId: `${input.source ?? 'session'}:${input.rootGoalId}`,
        rootGoalId: input.rootGoalId,
        source: input.source ?? 'session',
        title:
            input.title ??
            input.snapshot.goals[0]?.statement.slice(0, 120) ??
            input.rootGoalId,
        status,
        success: status === 'success',
        startedAt,
        completedAt,
        latencyMs: Math.max(0, completedAt - startedAt),
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
        ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
        ...(input.userId !== undefined ? { userId: input.userId } : {}),
        ...(input.conversationId !== undefined
            ? { conversationId: input.conversationId }
            : {}),
        ...(input.experimentId !== undefined ? { experimentId: input.experimentId } : {}),
        ...(input.arm !== undefined ? { arm: input.arm } : {}),
        ...(modelId !== undefined ? { modelId } : {}),
        promptPackIds: [...new Set(promptPackIds)],
        tasks: {
            total: tasks.length,
            succeeded,
            failed,
            aborted,
        },
        acceptance: {
            passed: acceptancePassed,
            failed: acceptanceFailed,
            evaluated: acceptanceEvaluated,
            total: acceptanceConditions.length,
        },
        tools: {
            calls: invocations.length,
            succeeded: toolSucceeded,
            failed: toolFailed,
            blocked: toolBlocked,
            successRate: invocations.length === 0 ? 1 : toolSucceeded / invocations.length,
            duplicateCalls,
        },
        interventions: approvalEvents.length,
        approvalsDenied,
        replans,
        steps: steps.length,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        totalTokens: inputTokens + outputTokens,
        costUsd,
        ...(primaryFailure !== undefined ? { failureCategory: primaryFailure } : {}),
        failureCounts,
        failureEvidence: [...new Set(failureEvidence)].slice(0, 20),
        ...(finalAnswer !== undefined ? { finalAnswer } : {}),
    };
}
