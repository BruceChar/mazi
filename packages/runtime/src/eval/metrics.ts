import { attributeFailure } from './attribution.js';
import type {
    EvalAggregate,
    EvalDifficulty,
    EvalObservation,
    EvalReport,
    EvalTask,
    EvalTaskResult,
    FailureCategory,
} from './types.js';

function ratio(numerator: number, denominator: number): number {
    return denominator <= 0 ? 0 : numerator / denominator;
}

function orderedMatches(expected: readonly string[], actual: readonly string[]): number {
    const rows = expected.length + 1;
    const cols = actual.length + 1;
    const lcs = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
    for (let i = 1; i < rows; i += 1) {
        for (let j = 1; j < cols; j += 1) {
            const row = lcs[i];
            if (row === undefined) continue;
            row[j] =
                expected[i - 1] === actual[j - 1]
                    ? (lcs[i - 1]?.[j - 1] ?? 0) + 1
                    : Math.max(lcs[i - 1]?.[j] ?? 0, row[j - 1] ?? 0);
        }
    }
    return lcs[expected.length]?.[actual.length] ?? 0;
}

export function evaluateObservation(task: EvalTask, observation: EvalObservation): EvalTaskResult {
    const expected = task.expectedTools ?? [];
    const actual = observation.toolCalls.map((call) => call.toolName);
    const matches = orderedMatches(expected, actual);
    const attribution = attributeFailure(task, observation);
    return {
        task,
        observation,
        success: observation.ok && observation.acceptance.passed,
        toolCallAccuracy:
            expected.length === 0 && actual.length === 0
                ? 1
                : (ratio(matches, actual.length) + ratio(matches, expected.length)) / 2,
        toolPrecision: ratio(matches, actual.length),
        toolRecall: ratio(matches, expected.length),
        intervention: observation.interventions > 0,
        totalTokens: observation.inputTokens + observation.outputTokens,
        ...(attribution.category !== undefined ? { failureCategory: attribution.category } : {}),
        failureEvidence: attribution.evidence,
    };
}

function percentile(values: readonly number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return sorted[index] ?? 0;
}

function average(values: readonly number[]): number {
    return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function aggregateResults(results: readonly EvalTaskResult[]): EvalAggregate {
    const failures: Partial<Record<FailureCategory, number>> = {};
    for (const result of results) {
        if (result.failureCategory === undefined) continue;
        failures[result.failureCategory] = (failures[result.failureCategory] ?? 0) + 1;
    }
    const memoryResults = results.filter(
        (result) =>
            result.observation.memory?.recallAtK !== undefined ||
            result.observation.memory?.precision !== undefined,
    );
    const memoryRecall = memoryResults
        .map((result) => result.observation.memory?.recallAtK)
        .filter((value): value is number => value !== undefined);
    const memoryPrecision = memoryResults
        .map((result) => result.observation.memory?.precision)
        .filter((value): value is number => value !== undefined);
    const successes = results.filter((result) => result.success).length;
    return {
        tasks: results.length,
        successes,
        successRate: ratio(successes, results.length),
        toolCallAccuracy: average(results.map((result) => result.toolCallAccuracy)),
        interventionRate: ratio(
            results.filter((result) => result.intervention).length,
            results.length,
        ),
        averageSteps: average(results.map((result) => result.observation.steps)),
        averageLatencyMs: average(results.map((result) => result.observation.latencyMs)),
        p50LatencyMs: percentile(
            results.map((result) => result.observation.latencyMs),
            0.5,
        ),
        p95LatencyMs: percentile(
            results.map((result) => result.observation.latencyMs),
            0.95,
        ),
        averageTokens: average(results.map((result) => result.totalTokens)),
        averageCostUsd: average(results.map((result) => result.observation.costUsd)),
        ...(memoryRecall.length > 0 ? { memoryRecallAtK: average(memoryRecall) } : {}),
        ...(memoryPrecision.length > 0 ? { memoryPrecision: average(memoryPrecision) } : {}),
        staleInjectionCount: results.reduce(
            (sum, result) => sum + (result.observation.memory?.staleInjected ?? 0),
            0,
        ),
        crossProjectLeakCount: results.reduce(
            (sum, result) => sum + (result.observation.memory?.crossProjectLeaks ?? 0),
            0,
        ),
        failureCounts: failures,
    };
}

export function buildEvalReport(
    results: readonly EvalTaskResult[],
    now: () => number = Date.now,
): EvalReport {
    const difficulties: EvalDifficulty[] = ['simple', 'medium', 'hard', 'long-horizon'];
    const byDifficulty: EvalReport['byDifficulty'] = {};
    for (const difficulty of difficulties) {
        const subset = results.filter((result) => result.task.difficulty === difficulty);
        if (subset.length > 0) byDifficulty[difficulty] = aggregateResults(subset);
    }
    return {
        generatedAt: now(),
        overall: aggregateResults(results),
        byDifficulty,
        results: [...results],
    };
}
