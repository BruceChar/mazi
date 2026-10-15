/**
 * 实验指标采集 —— 从既有 Goal/Task/Step 快照投影（docs/AB测试设计.md §5 / AB-8）。
 *
 * 口径与 Trace 看板一致：token/cost/耗时来自 Step 上挂载的 Usage，按 roundId 去重
 * （一轮只计一次）；步数来自 Step 事实。不新增任何真相源。
 */

import type { ExperimentMetrics } from '@mazi/core';
import type { GoalTreeSnapshot, StepView } from '@mazi/libs';

export interface MetricsInput {
    snapshot: GoalTreeSnapshot;
    ok: boolean;
    /** 末个 Task 的停止原因（aborted 决定实验臂状态）。 */
    reason?: string;
    startedAt: number;
    endedAt: number;
    /** 本次运行带入的技能 id（inherit 全局挂载时为 []）。 */
    skills: readonly string[];
    /** 本次运行的有效开关值。 */
    features: Record<string, boolean>;
}

function stepsOf(snapshot: GoalTreeSnapshot): StepView[] {
    return snapshot.goals.flatMap((goal) => goal.tasks).flatMap((task) => task.steps);
}

export function collectMetrics(input: MetricsInput): ExperimentMetrics {
    const steps = stepsOf(input.snapshot);
    const deliberations = steps.filter((step) => step.kind === 'deliberation');
    const seenRounds = new Set<string>();
    const models = new Set<string>();
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    let costUsd = 0;
    let ttftMs = 0;

    for (const step of deliberations) {
        const usage = step.usage;
        if (usage === undefined) continue;
        const roundKey = usage.roundId ?? step.stepId;
        if (!seenRounds.has(roundKey)) {
            seenRounds.add(roundKey);
            inputTokens += usage.raw?.inputTokens ?? 0;
            outputTokens += usage.raw?.outputTokens ?? 0;
            cachedInputTokens += usage.raw?.cachedInputTokens ?? 0;
            costUsd += usage.cost?.totalCostUsd ?? 0;
            if (ttftMs === 0 && usage.timing?.ttftMs !== undefined) {
                ttftMs = usage.timing.ttftMs;
            }
        }
        if (typeof usage.raw?.modelId === 'string' && usage.raw.modelId.length > 0) {
            models.add(usage.raw.modelId);
        }
    }

    const last = deliberations[deliberations.length - 1];
    const finalAnswer = last?.answer ?? last?.content ?? '';
    const status: ExperimentMetrics['status'] =
        input.reason === 'aborted' ? 'aborted' : input.ok ? 'succeeded' : 'failed';

    return {
        ok: input.ok,
        status,
        tasks: input.snapshot.taskCount,
        steps: steps.length,
        toolCalls: steps.filter((step) => step.kind === 'invocation').length,
        modelRounds: deliberations.length,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        costUsd,
        durationMs: Math.max(0, input.endedAt - input.startedAt),
        ttftMs,
        finalAnswer,
        finalAnswerChars: finalAnswer.length,
        models: [...models].sort(),
        skills: [...input.skills].sort(),
        features: { ...input.features },
    };
}

/** 臂在创建/执行阶段异常时的兜底指标（对照实验仍要拿到两臂数据）。 */
export function failedMetrics(
    error: string,
    fields: { skills?: readonly string[]; features?: Record<string, boolean> } = {},
): ExperimentMetrics {
    return {
        ok: false,
        status: 'failed',
        tasks: 0,
        steps: 0,
        toolCalls: 0,
        modelRounds: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        costUsd: 0,
        durationMs: 0,
        ttftMs: 0,
        finalAnswer: error,
        finalAnswerChars: error.length,
        models: [],
        skills: [...(fields.skills ?? [])].sort(),
        features: { ...(fields.features ?? {}) },
    };
}
