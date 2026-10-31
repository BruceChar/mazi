import { describe, expect, it } from 'vitest';
import type { AcceptanceResult, Goal, Step, Task } from '@mazi/core';
import { ulid } from '@mazi/core';
import { evaluateAcceptance, rollupAcceptance } from '../src/gts/acceptance.js';
import type { TaskOutcome } from '../src/gts/goal-executor.js';

function goalWith(conditions: Goal['contract']['successConditions']): Goal {
    return {
        goalId: ulid(),
        statement: 's',
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

function outcome(over: Partial<TaskOutcome> = {}): TaskOutcome {
    const task: Task = {
        taskId: ulid(),
        goalId: ulid(),
        title: 't',
        acceptance: { conditions: [] },
        status: 'succeeded',
    };
    return { task, steps: [], ok: true, reason: 'final-answer', ...over };
}

function step(status: Step['status']): Step {
    return {
        stepId: ulid(),
        taskId: ulid(),
        goalId: ulid(),
        kind: 'deliberation',
        payload: { answer: 'x' },
        status,
        startedAt: 1,
    };
}

describe('acceptance（评估器：机械判定，判不到就标 unchecked）', () => {
    it('final-answer 条款：final-answer 收尾 → passed', () => {
        const id = ulid();
        const goal = goalWith([
            { id, checkType: 'deterministic', description: '产出最终回答', check: { kind: 'final-answer' } },
        ]);
        const result = evaluateAcceptance(goal, outcome(), () => 42);
        expect(result.checkedAt).toBe(42);
        expect(result.passed).toBe(true);
        expect(result.evaluated).toBe(1);
        expect(result.total).toBe(1);
        expect(result.conditions[0]).toMatchObject({ conditionId: id, status: 'passed' });
    });

    it('final-answer 条款：max-steps 收尾 → failed，整体 passed=false', () => {
        const goal = goalWith([
            { id: ulid(), checkType: 'deterministic', check: { kind: 'final-answer' } },
        ]);
        const result = evaluateAcceptance(goal, outcome({ ok: false, reason: 'max-steps' }));
        expect(result.conditions[0]?.status).toBe('failed');
        expect(result.passed).toBe(false);
    });

    it('no-failed-steps 条款：有失败 Step → failed；无失败 → passed', () => {
        const goal = goalWith([
            { id: ulid(), checkType: 'deterministic', check: { kind: 'no-failed-steps' } },
        ]);
        expect(evaluateAcceptance(goal, outcome({ steps: [step('succeeded')] })).passed).toBe(true);
        const bad = evaluateAcceptance(goal, outcome({ steps: [step('failed')] }));
        expect(bad.passed).toBe(false);
        expect(bad.conditions[0]?.detail).toContain('失败 Step 1');
    });

    it('语义条款与缺省 check 的确定性条款 → unchecked，不计入 evaluated', () => {
        const semanticId = ulid();
        const bareId = ulid();
        const goal = goalWith([
            { id: semanticId, checkType: 'semantic', description: '回答是否得体' },
            { id: bareId, checkType: 'deterministic' },
        ]);
        const result = evaluateAcceptance(goal, outcome());
        expect(result.evaluated).toBe(0);
        expect(result.total).toBe(2);
        expect(result.conditions.every((item) => item.status === 'unchecked')).toBe(true);
        // 未评估条款不阻断（Task 本身成功）
        expect(result.passed).toBe(true);
    });

    it('Goal 级汇总：全判通过=satisfied，含未判=partial，含失败/Task 失败=violated', () => {
        const pass = (ids: string[]): AcceptanceResult => ({
            checkedAt: 1,
            passed: true,
            evaluated: ids.length,
            total: ids.length,
            conditions: ids.map((conditionId) => ({ conditionId, status: 'passed' as const })),
        });
        expect(rollupAcceptance(['a', 'b'], [pass(['a', 'b'])])).toEqual({
            state: 'satisfied',
            total: 2,
            evaluated: 2,
            passed: 2,
            failed: 0,
        });
        // 语义条款未判 → partial（不谎报满足）
        const mixed: AcceptanceResult = {
            checkedAt: 1,
            passed: true,
            evaluated: 1,
            total: 2,
            conditions: [
                { conditionId: 'a', status: 'passed' },
                { conditionId: 'b', status: 'unchecked' },
            ],
        };
        expect(rollupAcceptance(['a', 'b'], [mixed])).toMatchObject({
            state: 'partial',
            evaluated: 1,
            passed: 1,
        });
        // 条款失败 → violated
        const failed: AcceptanceResult = {
            checkedAt: 1,
            passed: false,
            evaluated: 1,
            total: 1,
            conditions: [{ conditionId: 'a', status: 'failed', detail: 'executor:max-steps' }],
        };
        expect(rollupAcceptance(['a'], [failed]).state).toBe('violated');
        // Task 整体失败（评估器 passed=false）也 → violated，即便条款都是 unchecked
        const taskFailed: AcceptanceResult = {
            checkedAt: 1,
            passed: false,
            evaluated: 0,
            total: 1,
            conditions: [{ conditionId: 'a', status: 'unchecked' }],
        };
        expect(rollupAcceptance(['a'], [taskFailed]).state).toBe('violated');
        // 多 Task 合并：failed 优先于 passed
        expect(
            rollupAcceptance(['a'], [pass(['a']), { ...failed, conditions: [{ conditionId: 'a', status: 'failed' }] }]).state,
        ).toBe('violated');
        // 没跑过 / 无条款 → unchecked
        expect(rollupAcceptance(['a'], [undefined]).state).toBe('unchecked');
        expect(rollupAcceptance([], []).state).toBe('unchecked');
    });

    it('Task 失败：即使无 failed 条款也 passed=false', () => {
        const goal = goalWith([{ id: ulid(), checkType: 'semantic' }]);
        expect(evaluateAcceptance(goal, outcome({ ok: false, reason: 'aborted' })).passed).toBe(false);
    });
});
