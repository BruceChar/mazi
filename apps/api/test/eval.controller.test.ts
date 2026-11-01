import 'reflect-metadata';
import { EvalService } from '../src/eval/eval.service.js';
import { EvalController } from '../src/eval/eval.controller.js';
import { describe, expect, it } from 'vitest';
import type { ApiRuntimeService } from '../src/common/runtime.service.js';

function harness() {
    return {
        async runGoalSession() {
            return {
                rootGoalId: 'eval-goal',
                result: {
                    rootGoalId: 'eval-goal',
                    ok: true,
                    tasks: [
                        {
                            ok: true,
                            reason: 'final-answer',
                            finalMessage: 'ok',
                            steps: [],
                            task: {
                                taskId: 'task-1',
                                goalId: 'eval-goal',
                                title: 'eval',
                                acceptance: { conditions: ['answer'] },
                                status: 'succeeded',
                                acceptanceResult: {
                                    checkedAt: 1,
                                    passed: true,
                                    evaluated: 1,
                                    total: 1,
                                    conditions: [{ conditionId: 'answer', status: 'passed' }],
                                },
                            },
                        },
                    ],
                },
                snapshot: {
                    goals: [
                        {
                            tasks: [
                                {
                                    steps: [
                                        {
                                            stepId: 'step-1',
                                            goalId: 'eval-goal',
                                            taskId: 'task-1',
                                            kind: 'invocation',
                                            status: 'succeeded',
                                            startedAt: 1,
                                            toolName: 'fs.read',
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                },
            };
        },
        async goalSnapshot() {
            throw new Error('unused');
        },
        eventBus: {
            replay: () => [],
        },
    };
}

function setup(): EvalController {
    const runtime = {
        harness,
        setWorkspaceRoot: () => undefined,
    } as unknown as ApiRuntimeService;
    return new EvalController(new EvalService(runtime));
}

describe('eval controller', () => {
    it('lists the 30-task baseline dataset', () => {
        const result = setup().tasks();
        expect(result.dataset).toBe('p0-baseline');
        expect(result.tasks).toHaveLength(30);
    });

    it('runs selected tasks and returns a persisted report', async () => {
        const controller = setup();
        const run = await controller.run({
            taskIds: ['read-report'],
            modelId: 'faux-model',
            promptPackId: 'general',
        });
        expect(run.status).toBe('completed');
        expect(run.report?.overall).toMatchObject({
            tasks: 1,
            successes: 1,
            successRate: 1,
        });
        expect(controller.report(run.runId).results).toHaveLength(1);
        expect(controller.runs().runs[0]?.runId).toBe(run.runId);
    });

    it('rejects unknown tasks before starting a run', async () => {
        await expect(setup().run({ taskIds: ['missing'] })).rejects.toThrow(/未知评测任务/);
    });
});
