import { describe, expect, it } from 'vitest';
import type { Goal, GoalParent } from './gts.ts';
import { validateAttributionChain, validateCeilingMonotonicity } from './gts.ts';
import { PermissionLevel } from './authorization.ts';

function g(
    id: string,
    over: Partial<Goal> & { rootGoalId?: string; parent?: GoalParent } = {},
): Goal {
    return {
        goalId: id,
        rootGoalId: over.rootGoalId ?? id,
        parent: over.parent,
        kind: 'work',
        statement: 's',
        contract: {
            successConditions: [],
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
        createdAt: 0,
        ...over,
    };
}

describe('法律校验（AHF_CORE_GOAL §6/§10，纯函数）', () => {
    it('validateAttributionChain：单根（human 输入）通过', () => {
        const root = g('r', { kind: 'intake', origin: { kind: 'human' } });
        expect(validateAttributionChain(root, new Map([[root.goalId, root]]))).toEqual({
            ok: true,
        });
    });

    it('根缺 origin → 拒绝；孤儿 parent → 拒绝；环 → 拒绝', () => {
        const noOrigin = g('r');
        const idx = new Map([[noOrigin.goalId, noOrigin]]);
        expect(validateAttributionChain(noOrigin, idx)).toMatchObject({ ok: false });

        const child = g('c', { rootGoalId: 'r', parent: { type: 'split', goalId: 'r' } });
        expect(validateAttributionChain(child, new Map([[child.goalId, child]]))).toMatchObject({
            ok: false,
            reason: expect.stringContaining('parent'),
        });

        const a = g('a', { origin: { kind: 'system' } });
        const b = g('b', {
            rootGoalId: 'a',
            parent: { type: 'delegation', goalId: 'a', stepId: 's1' },
        });
        b.parent = { type: 'split', goalId: 'b' }; // 制造环（b→b）
        const cyc = new Map([
            [a.goalId, a],
            [b.goalId, b],
        ]);
        expect(validateAttributionChain(b, cyc)).toMatchObject({
            ok: false,
            reason: expect.stringContaining('cycle'),
        });
    });

    it('委托链（human → agent 委托 → work）三层可回溯', () => {
        const root = g('root', { kind: 'intake', origin: { kind: 'human' } });
        const intakeB = g('b-intake', {
            rootGoalId: 'root',
            kind: 'intake',
            parent: { type: 'delegation', goalId: 'root', stepId: 's0' },
        });
        const work = g('w', {
            rootGoalId: 'root',
            parent: { type: 'split', goalId: 'b-intake' },
        });
        const index = new Map([
            [root.goalId, root],
            [intakeB.goalId, intakeB],
            [work.goalId, work],
        ]);
        expect(validateAttributionChain(work, index)).toEqual({ ok: true });
    });

    it('validateCeilingMonotonicity：兄弟 budget 总和 ≤ parent、ceiling 递减合规', () => {
        const intake: Goal = g('intake', {
            kind: 'intake',
            origin: { kind: 'human' },
            permissionCeiling: 'autonomous',
            budget: { maxCostUsd: 1 },
        });
        const s1 = g('s1', {
            rootGoalId: 'intake',
            permissionCeiling: 'approved',
            budget: { maxCostUsd: 0.6 },
            parent: { type: 'split', goalId: 'intake' },
        });
        const s2: Goal = g('s2', {
            rootGoalId: 'intake',
            permissionCeiling: 'read-only',
            budget: { maxCostUsd: 0.4 },
            parent: { type: 'split', goalId: 'intake' },
        });
        const index = new Map<string, Goal>([
            [intake.goalId, intake],
            [s1.goalId, s1],
            [s2.goalId, s2],
        ]);
        expect(validateCeilingMonotonicity([intake, s1, s2], index)).toEqual({ ok: true });
    });

    it('validateCeilingMonotonicity：子层 ceiling 越权 → 拒绝', () => {
        const parent: Goal = g('p', {
            permissionCeiling: 'draft' as PermissionLevel,
            origin: { kind: 'human' },
        });
        const child = g('c', {
            rootGoalId: 'p',
            permissionCeiling: 'autonomous',
            parent: { type: 'split', goalId: 'p' },
        });
        const index = new Map<string, Goal>([
            [parent.goalId, parent],
            [child.goalId, child],
        ]);
        expect(validateCeilingMonotonicity([child], index)).toMatchObject({
            ok: false,
            reason: expect.stringContaining('ceiling'),
        });
    });
});
