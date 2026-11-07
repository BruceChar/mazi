import type { CheckableCondition, Goal } from '@mazi/core';
import { describe, expect, it } from 'vitest';
import type { TaskOutcome } from '../src/gts/goal-executor.js';
import {
    type ConditionEnvironment,
    IndependentVerifier,
    type SemanticJudge,
} from '../src/verifier/index.js';

function goalWithConditions(conditions: CheckableCondition[]): Goal {
    return {
        goalId: 'g1',
        statement: '完成任务',
        contract: {
            successConditions: conditions,
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

function goal(check: 'deterministic' | 'semantic'): Goal {
    return goalWithConditions([
        {
            id: 'c1',
            checkType: check,
            description: '输出必须基于证据',
            ...(check === 'deterministic' ? { check: { kind: 'final-answer' as const } } : {}),
        },
    ]);
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

describe('IndependentVerifier（注入 ConditionEnvironment，机械 + 语义混合）', () => {
    function fileGoal(): Goal {
        return goalWithConditions([
            {
                id: 'c1',
                checkType: 'deterministic',
                description: 'out/report.md 必须存在',
                check: { kind: 'file-exists', path: 'out/report.md' },
            },
            { id: 'c2', checkType: 'semantic', description: '报告结论与证据一致' },
        ]);
    }

    function outcomeFor(conditionIds: string[]): TaskOutcome {
        const base = outcome();
        return { ...base, task: { ...base.task, acceptance: { conditions: conditionIds } } };
    }

    const environment = (exists: boolean): ConditionEnvironment => ({
        fileExists: () => exists,
        readFile: () => (exists ? '报告正文' : null),
        gitHasCommit: () => false,
    });

    const judge: SemanticJudge = {
        id: 'judge-v1',
        async judge() {
            return { status: 'passed', confidence: 0.9, reason: '证据匹配' };
        },
    };

    it('注入 env：机械条款与语义条款都判定 → passed', async () => {
        const report = await new IndependentVerifier({
            semanticJudge: judge,
            environment: environment(true),
        }).verify(fileGoal(), outcomeFor(['c1', 'c2']));
        expect(report.state).toBe('passed');
        expect(report.acceptance.conditions.map((item) => item.status)).toEqual([
            'passed',
            'passed',
        ]);
        expect(report.acceptance.evaluated).toBe(2);
    });

    it('未注入 env：file 类 → unchecked，语义照判 → uncertain（不谎报通过）', async () => {
        const report = await new IndependentVerifier({ semanticJudge: judge }).verify(
            fileGoal(),
            outcomeFor(['c1', 'c2']),
        );
        expect(report.state).toBe('uncertain');
        expect(report.acceptance.conditions[0]).toMatchObject({
            conditionId: 'c1',
            status: 'unchecked',
        });
        expect(report.acceptance.conditions[1]).toMatchObject({
            conditionId: 'c2',
            status: 'passed',
        });
        expect(report.acceptance.evaluated).toBe(1);
    });

    it('env 判定失败 → failed（语义 judge 通过也掩盖不了机械失败）', async () => {
        const report = await new IndependentVerifier({
            semanticJudge: judge,
            environment: environment(false),
        }).verify(fileGoal(), outcomeFor(['c1', 'c2']));
        expect(report.state).toBe('failed');
        expect(report.acceptance.passed).toBe(false);
        expect(report.acceptance.conditions[0]).toMatchObject({
            conditionId: 'c1',
            status: 'failed',
        });
    });

    it('setEnvironment：构造后注入/替换环境探针', async () => {
        const verifier = new IndependentVerifier({ semanticJudge: judge });
        expect(verifier.hasEnvironment).toBe(false);
        const withoutEnv = await verifier.verify(fileGoal(), outcomeFor(['c1', 'c2']));
        expect(withoutEnv.acceptance.conditions[0]?.status).toBe('unchecked');

        verifier.setEnvironment(environment(true));
        expect(verifier.hasEnvironment).toBe(true);
        const withEnv = await verifier.verify(fileGoal(), outcomeFor(['c1', 'c2']));
        expect(withEnv.acceptance.conditions[0]?.status).toBe('passed');
    });
});
