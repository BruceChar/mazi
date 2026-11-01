import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    aggregateResults,
    buildEvalReport,
    loadEvalDataset,
    runEvalSuite,
    type EvalObservation,
} from '../src/index.js';

function observation(over: Partial<EvalObservation> = {}): EvalObservation {
    return {
        ok: true,
        acceptance: {
            checkedAt: 1,
            passed: true,
            evaluated: 1,
            total: 1,
            conditions: [{ conditionId: 'answer', status: 'passed' }],
        },
        steps: 2,
        toolCalls: [{ toolName: 'fs.read', ok: true, argumentValid: true }],
        interventions: 0,
        replans: 0,
        latencyMs: 100,
        inputTokens: 80,
        outputTokens: 20,
        costUsd: 0.01,
        promptTokens: 40,
        ...over,
    };
}

describe('P0 eval harness', () => {
    it('loads and validates the 30-task baseline dataset', () => {
        const tasks = loadEvalDataset(join(import.meta.dirname, '../tasks/p0-baseline.json'));
        expect(tasks).toHaveLength(30);
        expect(new Set(tasks.map((task) => task.difficulty))).toEqual(
            new Set(['simple', 'medium', 'hard', 'long-horizon']),
        );
    });

    it('runs a suite and aggregates success, tools, intervention and cost', async () => {
        const tasks = loadEvalDataset(join(import.meta.dirname, '../tasks/p0-baseline.json')).slice(
            0,
            2,
        );
        const results = await runEvalSuite(tasks, async ({ task }) =>
            observation({
                toolCalls: [{ toolName: task.expectedTools?.[0] ?? 'x', ok: true }],
                interventions: task.id === 'search-symbol' ? 1 : 0,
            }),
        );
        const aggregate = aggregateResults(results);
        expect(aggregate).toMatchObject({
            tasks: 2,
            successes: 2,
            successRate: 1,
            toolCallAccuracy: 1,
            averageTokens: 100,
            averageCostUsd: 0.01,
        });
        expect(aggregate.interventionRate).toBe(0.5);
    });

    it('attributes tool execution and selection failures', async () => {
        const tasks = loadEvalDataset(join(import.meta.dirname, '../tasks/p0-baseline.json'));
        const execution = await runEvalSuite([tasks[0]!], async () =>
            observation({
                ok: false,
                acceptance: {
                    checkedAt: 1,
                    passed: false,
                    evaluated: 1,
                    total: 1,
                    conditions: [{ conditionId: 'answer', status: 'failed' }],
                },
                toolCalls: [{ toolName: 'fs.read', ok: false }],
            }),
        );
        expect(execution[0]?.failureCategory).toBe('tool_execution');

        const selection = await runEvalSuite([tasks[0]!], async () =>
            observation({
                ok: false,
                acceptance: {
                    checkedAt: 1,
                    passed: false,
                    evaluated: 1,
                    total: 1,
                    conditions: [{ conditionId: 'answer', status: 'failed' }],
                },
                toolCalls: [],
            }),
        );
        expect(selection[0]?.failureCategory).toBe('tool_selection');
    });

    it('builds a report grouped by difficulty', async () => {
        const tasks = loadEvalDataset(join(import.meta.dirname, '../tasks/p0-baseline.json')).slice(
            0,
            3,
        );
        const results = await runEvalSuite(tasks, async () => observation());
        const report = buildEvalReport(results, () => 42);
        expect(report.generatedAt).toBe(42);
        expect(report.overall.successRate).toBe(1);
        expect(report.byDifficulty.simple?.tasks).toBe(3);
    });
});
