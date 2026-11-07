import { describe, expect, it } from 'vitest';
import type {
    AcceptanceResult,
    CheckableCondition,
    ConditionCheck,
    Goal,
    Step,
    Task,
} from '@mazi/core';
import { ulid } from '@mazi/core';
import { type ConditionEnvironment, evaluateAcceptance, rollupAcceptance } from '../src/gts/acceptance.js';
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

/** shell.run invocation 事实（command-output-contains 只读已落库证据，不重新执行）。 */
function invocation(command: string, output: string, toolName = 'shell.run'): Step {
    return {
        stepId: ulid(),
        taskId: ulid(),
        goalId: ulid(),
        kind: 'invocation',
        payload: { toolName, arguments: { command }, output },
        status: 'succeeded',
        startedAt: 1,
    };
}

/** 内存环境探针：文件表 + git 事实，替代真实 fs/git（评估器不直接触碰世界）。 */
function environment(
    files: Record<string, string>,
    options: { hasCommit?: boolean } = {},
): ConditionEnvironment {
    return {
        fileExists: (path) => Object.hasOwn(files, path),
        readFile: (path) => files[path] ?? null,
        gitHasCommit: () => options.hasCommit === true,
    };
}

function mechanical(check: ConditionCheck, description = '条款'): CheckableCondition {
    return { id: ulid(), checkType: 'deterministic', description, check };
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

describe('机械检查词表 v2（环境探针）', () => {
    it('file-exists：存在 → passed；缺失 → failed 且整体 passed=false', () => {
        const present = goalWith([mechanical({ kind: 'file-exists', path: 'out/report.md' })]);
        expect(
            evaluateAcceptance(present, outcome(), undefined, environment({ 'out/report.md': '' }))
                .conditions[0]?.status,
        ).toBe('passed');

        const absent = goalWith([mechanical({ kind: 'file-exists', path: 'out/missing.md' })]);
        const absentResult = evaluateAcceptance(absent, outcome(), undefined, environment({}));
        expect(absentResult.conditions[0]?.status).toBe('failed');
        expect(absentResult.conditions[0]?.detail).toContain('不存在');
        expect(absentResult.passed).toBe(false);
    });

    it('file-contains：内容包含 → passed；不包含 / 不可读 → failed', () => {
        const goal = goalWith([
            mechanical({ kind: 'file-contains', path: 'src/a.ts', text: 'export const x' }),
        ]);
        const hit = environment({ 'src/a.ts': 'const a = 1;\nexport const x = 1;' });
        expect(evaluateAcceptance(goal, outcome(), undefined, hit).conditions[0]?.status).toBe(
            'passed',
        );

        const missText = environment({ 'src/a.ts': 'export const y = 1;' });
        expect(
            evaluateAcceptance(goal, outcome(), undefined, missText).conditions[0]?.status,
        ).toBe('failed');

        // readFile 返回 null（文件缺失或不可读）→ failed，不抛错
        const unreadable = environment({});
        const unreadableResult = evaluateAcceptance(goal, outcome(), undefined, unreadable);
        expect(unreadableResult.conditions[0]?.status).toBe('failed');
        expect(unreadableResult.conditions[0]?.detail).toContain('不可读');
    });

    it('git-has-commit：有 commit → passed；无 → failed', () => {
        const goal = goalWith([mechanical({ kind: 'git-has-commit' })]);
        expect(
            evaluateAcceptance(goal, outcome(), undefined, environment({}, { hasCommit: true }))
                .conditions[0]?.status,
        ).toBe('passed');
        expect(
            evaluateAcceptance(goal, outcome(), undefined, environment({})).conditions[0]?.status,
        ).toBe('failed');
    });

    it('无环境探针：file / git 类 → unchecked（detail 说明），不计入 evaluated 且不阻断', () => {
        const goal = goalWith([
            mechanical({ kind: 'file-exists', path: 'a' }),
            mechanical({ kind: 'file-contains', path: 'a', text: 'x' }),
            mechanical({ kind: 'git-has-commit' }),
        ]);
        const result = evaluateAcceptance(goal, outcome());
        expect(result.conditions.map((item) => item.status)).toEqual([
            'unchecked',
            'unchecked',
            'unchecked',
        ]);
        expect(result.conditions[0]?.detail).toContain('环境');
        expect(result.evaluated).toBe(0);
        expect(result.total).toBe(3);
        // unchecked 不冒充失败：Task 本身成功时整体仍通过
        expect(result.passed).toBe(true);
    });

    it('command-output-contains：只在已落库 shell.run 证据里匹配 command 与 output，不重新执行', () => {
        const goal = goalWith([
            mechanical({
                kind: 'command-output-contains',
                commandPattern: 'pnpm\\s+test',
                text: 'Test Files',
            }),
        ]);
        const hit = outcome({ steps: [invocation('pnpm test', 'Test Files 12 passed (12)')] });
        // 该 check 只依赖 outcome：无 env 也能判
        expect(evaluateAcceptance(goal, hit).conditions[0]?.status).toBe('passed');

        const wrongCommand = outcome({ steps: [invocation('pnpm build', 'Test Files ok')] });
        expect(evaluateAcceptance(goal, wrongCommand).conditions[0]?.status).toBe('failed');

        const wrongOutput = outcome({ steps: [invocation('pnpm test', 'FAIL src/a.test.ts')] });
        expect(evaluateAcceptance(goal, wrongOutput).conditions[0]?.status).toBe('failed');

        // 非 shell.run 的工具调用不算命令证据
        const otherTool = outcome({ steps: [invocation('pnpm test', 'Test Files ok', 'fs.read')] });
        expect(evaluateAcceptance(goal, otherTool).conditions[0]?.status).toBe('failed');
    });

    it('command-output-contains：非法正则按字面子串匹配（不让一条坏 pattern 炸掉整次验收）', () => {
        const goal = goalWith([
            mechanical({
                kind: 'command-output-contains',
                commandPattern: 'pnpm test(',
                text: 'passed',
            }),
        ]);
        const hit = outcome({ steps: [invocation('pnpm test(', 'passed')] });
        expect(evaluateAcceptance(goal, hit).conditions[0]?.status).toBe('passed');
        expect(evaluateAcceptance(goal, outcome({ steps: [] })).conditions[0]?.status).toBe(
            'failed',
        );
    });
});
