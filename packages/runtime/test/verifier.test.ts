import type { Goal } from '@mazi/core';
import { describe, expect, it } from 'vitest';
import type { TaskOutcome } from '../src/gts/goal-executor.js';
import { IndependentVerifier, type SemanticJudge } from '../src/verifier/index.js';

function goal(check: 'deterministic' | 'semantic'): Goal {
    return {
        goalId: 'g1',
        statement: '完成任务',
        contract: {
            successConditions: [
                {
                    id: 'c1',
                    checkType: check,
                    description: '输出必须基于证据',
                    ...(check === 'deterministic'
                        ? { check: { kind: 'final-answer' as const } }
                        : {}),
                },
            ],
            failureConditions: [],
            forbiddenResources: [],
            budget: {},
            terminationPolicy: {},
            riskProfile: {
                hasIrreversibleActions: false,
                touchesNetwork: false,
                touchesExternalApi: false,
            },
        },
        permissionCeiling: 'read-only',
        budget: {},
        status: 'active',
        createdAt: 1,
    };
}

function outcome(over: Partial<TaskOutcome> = {}): TaskOutcome {
    return {
        task: {
            taskId: 't1',
            goalId: 'g1',
            title: '任务',
            acceptance: { conditions: ['c1'] },
            status: 'succeeded',
        },
        steps: [],
        ok: true,
        reason: 'final-answer',
        finalMessage: '有证据的答案',
        ...over,
    };
}

describe('IndependentVerifier', () => {
    it('passes deterministic checks independently of executor self-report', async () => {
        const report = await new IndependentVerifier().verify(goal('deterministic'), outcome());
        expect(report).toMatchObject({ state: 'passed', verifierId: 'independent-default' });
        expect(report.acceptance.conditions[0]?.status).toBe('passed');
    });

    it('keeps semantic checks uncertain without a calibrated judge', async () => {
        const report = await new IndependentVerifier().verify(goal('semantic'), outcome());
        expect(report.state).toBe('uncertain');
        expect(report.acceptance.conditions[0]?.status).toBe('unchecked');
    });

    it('uses an injected semantic judge and records its identity', async () => {
        const judge: SemanticJudge = {
            id: 'judge-v1',
            version: 'calibrated-1',
            async judge() {
                return { status: 'passed', confidence: 0.92, reason: '证据匹配' };
            },
        };
        const report = await new IndependentVerifier({ semanticJudge: judge }).verify(
            goal('semantic'),
            outcome(),
        );
        expect(report.state).toBe('passed');
        expect(report.semanticJudgeId).toBe('judge-v1');
        expect(report.acceptance.conditions[0]?.detail).toContain('confidence=0.92');
    });

    it('attributes policy and tool failures from observable step errors', async () => {
        const policy = await new IndependentVerifier().verify(
            goal('deterministic'),
            outcome({
                ok: false,
                reason: 'blocked-tool',
                steps: [
                    {
                        stepId: 's1',
                        goalId: 'g1',
                        taskId: 't1',
                        kind: 'invocation',
                        payload: { toolName: 'shell.run', arguments: {}, output: 'denied' },
                        status: 'blocked',
                        error: {
                            code: 'policy',
                            message: 'denied',
                            source: 'policy',
                            retryable: false,
                        },
                        startedAt: 1,
                    },
                ],
            }),
        );
        expect(policy.failureCategory).toBe('policy');
        expect(policy.state).toBe('failed');
    });
});
