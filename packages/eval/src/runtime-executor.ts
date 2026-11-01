import type { HarnessEvent } from '@mazi/core';
import type { GoalRunResult, GoalTreeSnapshot, RunOptions } from '@mazi/runtime';
import type { EvalExecutionContext, EvalObservation, EvalTaskExecutor } from './types.js';

export interface EvalRuntimePort {
    runGoalSession(
        input: string,
        options?: RunOptions,
    ): Promise<{
        rootGoalId: string;
        result: GoalRunResult;
        snapshot: GoalTreeSnapshot;
    }>;
    goalSnapshot(rootGoalId: string): Promise<GoalTreeSnapshot>;
    eventBus: { replay(rootGoalId: string): HarnessEvent[] };
}

export interface RuntimeEvalExecutorOptions {
    permissionCeiling?: RunOptions['permissionCeiling'];
    projectPrefix?: string;
}

function permissionOf(context: EvalExecutionContext): RunOptions['permissionCeiling'] {
    if (context.task.risk === 'read-only') return 'read-only';
    if (context.task.risk === 'workspace-write') return 'workspace-write';
    return 'approved';
}

export function createRuntimeEvalExecutor(
    runtime: EvalRuntimePort,
    options: RuntimeEvalExecutorOptions = {},
): EvalTaskExecutor {
    return async (context) => {
        const startedAt = Date.now();
        const run = await runtime.runGoalSession(context.task.input, {
            projectId: `${options.projectPrefix ?? 'eval'}:${context.task.id}`,
            allowedTools: context.task.allowedTools,
            permissionCeiling: permissionOf(context),
            ...(context.modelId !== undefined ? { modelId: context.modelId } : {}),
            ...(context.promptPackId !== undefined
                ? { promptPackIds: [context.promptPackId] }
                : {}),
            ...(context.task.budget?.maxSteps !== undefined
                ? { maxSteps: context.task.budget.maxSteps }
                : {}),
            ...(context.task.budget?.maxCostUsd !== undefined
                ? { maxCostUsd: context.task.budget.maxCostUsd }
                : {}),
            ...(options.permissionCeiling !== undefined
                ? { permissionCeiling: options.permissionCeiling }
                : {}),
        });
        return observationOf(context, run, Date.now() - startedAt, runtime);
    };
}

function observationOf(
    context: EvalExecutionContext,
    run: Awaited<ReturnType<EvalRuntimePort['runGoalSession']>>,
    measuredLatencyMs: number,
    runtime: EvalRuntimePort,
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
    const interventions = events.filter((event) => event.type === 'approval.requested').length;
    const planCount = events.filter((event) => event.type === 'plan.created').length;
    const last = run.result.tasks.at(-1);
    return {
        ok: run.result.ok,
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
        ...(last?.finalMessage !== undefined ? { finalAnswer: last.finalMessage } : {}),
        ...(last?.reason !== undefined ? { failureEvidence: [`executor:${last.reason}`] } : {}),
    };
}
