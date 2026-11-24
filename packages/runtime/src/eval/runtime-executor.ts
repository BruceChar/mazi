import type { HarnessEvent } from '@mazi/core';
import type { GoalTreeSnapshot } from '@mazi/libs';
import type { RunOptions } from '../harness/conversation.js';
import type { GoalRunResult } from '../strategy/goal-strategy.js';
import type { EvalExecutionContext, EvalObservation, EvalTaskExecutor } from './types.js';

/**
 * 评测执行端口：拆成 create / execute / stop / resume 四步，
 * 让上层能在会话创建后立刻拿到 rootGoalId（订阅事件流、停止、恢复），
 * 而不是像 runGoalSession 那样只能等整轮结束。
 */
export interface EvalRuntimePort {
    createGoalSession(
        input: string,
        options?: RunOptions,
    ): Promise<{ rootGoalId: string; goalId: string }>;
    executeGoalTree(rootGoalId: string, options?: { resume?: boolean }): Promise<GoalRunResult>;
    resumeGoalTree(
        rootGoalId: string,
        options?: {
            modelId?: string;
            promptPackIds?: readonly string[];
            allowedTools?: readonly string[];
        },
    ): Promise<GoalRunResult>;
    goalSnapshot(rootGoalId: string): Promise<GoalTreeSnapshot>;
    stopGoalTree(rootGoalId: string): boolean;
    isGoalRunning(rootGoalId: string): boolean;
    eventBus: { replay(rootGoalId: string): HarnessEvent[] };
}

export interface RuntimeEvalExecutorOptions {
    permissionCeiling?: RunOptions['permissionCeiling'];
    projectPrefix?: string;
    /** 会话创建即回调 rootGoalId：UI 据此订阅 SSE、停止/恢复。 */
    onSessionStarted?: (taskId: string, rootGoalId: string) => void;
}

function permissionOf(context: EvalExecutionContext): RunOptions['permissionCeiling'] {
    if (context.task.risk === 'read-only') return 'read-only';
    if (context.task.risk === 'workspace-write') return 'workspace-write';
    return 'approved';
}

function runOptionsOf(
    context: EvalExecutionContext,
    options: RuntimeEvalExecutorOptions,
): RunOptions {
    return {
        projectId: `${options.projectPrefix ?? 'eval'}:${context.task.id}`,
        allowedTools: context.task.allowedTools,
        permissionCeiling: permissionOf(context),
        ...(context.modelId !== undefined ? { modelId: context.modelId } : {}),
        ...(context.promptPackId !== undefined ? { promptPackIds: [context.promptPackId] } : {}),
        ...(context.task.budget?.maxSteps !== undefined
            ? { maxSteps: context.task.budget.maxSteps }
            : {}),
        ...(context.task.budget?.maxCostUsd !== undefined
            ? { maxCostUsd: context.task.budget.maxCostUsd }
            : {}),
        ...(options.permissionCeiling !== undefined
            ? { permissionCeiling: options.permissionCeiling }
            : {}),
    };
}

function resumeOptionsOf(context: EvalExecutionContext): {
    modelId?: string;
    promptPackIds?: readonly string[];
    allowedTools?: readonly string[];
} {
    return {
        allowedTools: context.task.allowedTools,
        ...(context.modelId !== undefined ? { modelId: context.modelId } : {}),
        ...(context.promptPackId !== undefined ? { promptPackIds: [context.promptPackId] } : {}),
    };
}

export function createRuntimeEvalExecutor(
    runtime: EvalRuntimePort,
    options: RuntimeEvalExecutorOptions = {},
): EvalTaskExecutor {
    return async (context) => {
        const startedAt = Date.now();
        // 已停止任务带 rootGoalId 回来：从已落库 Step 续跑，而不是新建会话。
        let rootGoalId = context.resumeGoalId;
        let result: GoalRunResult;
        if (rootGoalId !== undefined) {
            result = await runtime.resumeGoalTree(rootGoalId, resumeOptionsOf(context));
        } else {
            const created = await runtime.createGoalSession(
                context.task.input,
                runOptionsOf(context, options),
            );
            rootGoalId = created.rootGoalId;
            options.onSessionStarted?.(context.task.id, rootGoalId);
            result = await runtime.executeGoalTree(rootGoalId);
        }
        const snapshot = await runtime.goalSnapshot(rootGoalId);
        const aborted = result.tasks.some((outcome) => outcome.reason === 'aborted');
        return observationOf(
            context,
            { rootGoalId, result, snapshot },
            Date.now() - startedAt,
            runtime,
            aborted,
        );
    };
}

export function observationOf(
    context: EvalExecutionContext,
    run: {
        rootGoalId: string;
        result: GoalRunResult;
        snapshot: GoalTreeSnapshot;
    },
    measuredLatencyMs: number,
    runtime: EvalRuntimePort,
    aborted = false,
): EvalObservation {
    const snapshot = run.snapshot;
    const steps = snapshot.goals.flatMap((goal) => goal.tasks).flatMap((task) => task.steps);
    const toolSteps = steps.filter((step) => step.kind === 'invocation');
    const runtimeConditions = run.result.tasks.flatMap(
        (outcome) => outcome.task.acceptanceResult?.conditions ?? [],
    );
    const conditions = context.task.acceptance.map((condition, index) => {
        const result = runtimeConditions[index];
        return {
            conditionId: condition.id,
            status: result?.status ?? ('unchecked' as const),
            ...(result?.detail !== undefined ? { detail: result.detail } : {}),
        };
    });
    const evaluated = conditions.filter((condition) => condition.status !== 'unchecked').length;
    const passed =
        !aborted &&
        run.result.ok &&
        conditions.every((condition) => condition.status !== 'failed') &&
        (context.task.acceptance.every((condition) => condition.kind !== 'deterministic') ||
            evaluated > 0);

    const seenRounds = new Set<string>();
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    let costUsd = 0;
    for (const step of steps) {
        if (step.usage === undefined) continue;
        const key = step.usage.roundId ?? step.stepId;
        if (seenRounds.has(key)) continue;
        seenRounds.add(key);
        inputTokens += step.usage.raw?.inputTokens ?? 0;
        outputTokens += step.usage.raw?.outputTokens ?? 0;
        cachedInputTokens += step.usage.raw?.cachedInputTokens ?? 0;
        costUsd += step.usage.cost?.totalCostUsd ?? 0;
    }
    const events = runtime.eventBus.replay(run.rootGoalId);
    const eventCounts: Record<string, number> = {};
    for (const event of events) {
        eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
    }
    const interventions = eventCounts['approval.requested'] ?? 0;
    const planCount = eventCounts['plan.created'] ?? 0;
    const last = run.result.tasks.at(-1);
    return {
        ok: !aborted && run.result.ok,
        acceptance: {
            checkedAt: Date.now(),
            passed,
            evaluated,
            total: conditions.length,
            conditions,
        },
        steps: steps.length,
        toolCalls: toolSteps.map((step) => ({
            toolName: step.toolName ?? 'unknown',
            ok: step.status === 'succeeded',
            argumentValid:
                step.status !== 'error' ||
                step.usage?.runtime !== undefined ||
                step.toolArguments !== undefined,
        })),
        interventions,
        replans: Math.max(0, planCount - 1),
        latencyMs: measuredLatencyMs,
        inputTokens,
        outputTokens,
        ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
        costUsd,
        runtime: {
            rootGoalId: run.rootGoalId,
            turns: eventCounts['turn.started'] ?? 0,
            resumed: (eventCounts['run.resumed'] ?? 0) > 0,
            eventCounts,
        },
        ...(last?.finalMessage !== undefined ? { finalAnswer: last.finalMessage } : {}),
        ...(last?.reason !== undefined ? { failureEvidence: [`executor:${last.reason}`] } : {}),
        ...(aborted ? { aborted: true } : {}),
    };
}
