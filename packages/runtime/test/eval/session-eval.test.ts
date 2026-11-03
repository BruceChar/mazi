import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GoalRunResult, GoalTreeSnapshot } from '@mazi/runtime';
import {
    projectSessionEvaluation,
    SqliteSessionEvaluationStore,
} from '../../src/eval/index.js';

const snapshot: GoalTreeSnapshot = {
    rootGoalId: 'root-1',
    taskCount: 1,
    stepCount: 2,
    goals: [
        {
            goalId: 'root-1',
            status: 'succeeded',
            statement: '读取并修改文件',
            tasks: [
                {
                    taskId: 'task-1',
                    title: '执行',
                    status: 'succeeded',
                    acceptanceResult: {
                        checkedAt: 3,
                        passed: true,
                        evaluated: 1,
                        total: 1,
                        conditions: [{ conditionId: 'done', status: 'passed' }],
                    },
                    steps: [
                        {
                            stepId: 'step-1',
                            goalId: 'root-1',
                            taskId: 'task-1',
                            kind: 'deliberation',
                            status: 'succeeded',
                            startedAt: 10,
                            endedAt: 20,
                            usage: {
                                roundId: 'round-1',
                                raw: {
                                    modelId: 'model-a',
                                    inputTokens: 100,
                                    outputTokens: 20,
                                    cachedInputTokens: 40,
                                },
                                cost: {
                                    inputCostUsd: 0.01,
                                    outputCostUsd: 0.02,
                                    cacheWriteCostUsd: 0,
                                    cacheReadCostUsd: 0,
                                    reasoningCostUsd: 0,
                                    totalCostUsd: 0.03,
                                },
                            },
                        },
                        {
                            stepId: 'step-2',
                            goalId: 'root-1',
                            taskId: 'task-1',
                            kind: 'invocation',
                            status: 'succeeded',
                            startedAt: 21,
                            endedAt: 25,
                            toolName: 'fs.read',
                            toolArguments: { path: 'README.md' },
                        },
                    ],
                },
            ],
        },
    ],
};

const result: GoalRunResult = {
    rootGoalId: 'root-1',
    ok: true,
    tasks: [
        {
            task: {
                taskId: 'task-1',
                goalId: 'root-1',
                title: '执行',
                acceptance: { conditions: ['done'] },
                status: 'succeeded',
            },
            steps: [],
            ok: true,
            reason: 'final-answer',
            finalMessage: 'done',
        },
    ],
};

describe('session evaluation projection', () => {
    it('projects trace facts into business metrics', () => {
        const record = projectSessionEvaluation({
            rootGoalId: 'root-1',
            snapshot,
            result,
            projectId: 'project-a',
            events: [
                {
                    eventId: 'e1',
                    type: 'approval.requested',
                    rootGoalId: 'root-1',
                    timestamp: 12,
                    attributes: {},
                },
                {
                    eventId: 'e2',
                    type: 'superagent.decision',
                    rootGoalId: 'root-1',
                    timestamp: 13,
                    attributes: {},
                    payload: { promptPackIds: ['coding'] },
                },
            ],
        });
        expect(record).toMatchObject({
            source: 'session',
            status: 'success',
            success: true,
            projectId: 'project-a',
            modelId: 'model-a',
            promptPackIds: ['coding'],
            steps: 2,
            totalTokens: 120,
            costUsd: 0.03,
            interventions: 1,
            tools: { calls: 1, succeeded: 1, successRate: 1 },
            acceptance: { passed: 1, failed: 0, evaluated: 1, total: 1 },
            finalAnswer: 'done',
        });
    });

    it('persists evaluations by root goal across store instances', async () => {
        const dbPath = join(mkdtempSync(join(tmpdir(), 'mazi-session-eval-')), 'mazi.db');
        const record = projectSessionEvaluation({
            rootGoalId: 'root-1',
            snapshot,
            result,
            events: [],
        });
        const first = new SqliteSessionEvaluationStore(dbPath);
        await first.save(record);
        first.close();

        const second = new SqliteSessionEvaluationStore(dbPath);
        expect(await second.get('root-1')).toMatchObject({ status: 'success' });
        expect(await second.list({ projectId: 'missing' })).toHaveLength(0);
        second.close();
    });
});
