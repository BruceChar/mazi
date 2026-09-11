import { describe, expect, it } from 'vitest';
import type { Goal, GoalParent } from '../src/gts.js';
import { validateAttributionChain, validateCeilingMonotonicity } from '../src/gts.js';
import { PermissionLevel } from '../src/permissions.js';
import { ULID, ulid } from '../src/id.js';

function g(
    id: ULID,
    over: Partial<Goal> & { rootGoalId?: ULID; parent?: GoalParent } = {},
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
        const root = g(ulid(), { kind: 'intake', origin: { kind: 'human' } });
        expect(validateAttributionChain(root, new Map([[root.goalId, root]]))).toEqual({
            ok: true,
        });
    });

    it('根缺 origin → 拒绝；孤儿 parent → 拒绝；环 → 拒绝', () => {
        const noOrigin = g(ulid());
        const idx = new Map([[noOrigin.goalId, noOrigin]]);
        expect(validateAttributionChain(noOrigin, idx)).toMatchObject({ ok: false });

        const child = g(ulid(), { rootGoalId: noOrigin.goalId, parent: { type: 'split', goalId: noOrigin.goalId } });
        expect(validateAttributionChain(child, new Map([[child.goalId, child]]))).toMatchObject({
            ok: false,
            reason: expect.stringContaining('parent'),
        });

        const a = g(ulid(), { origin: { kind: 'system' } });
        const b = g(ulid(), {
            rootGoalId: a.goalId,
            parent: { type: 'delegation', goalId: a.goalId, stepId: ulid() },
        });
        b.parent = { type: 'split', goalId: b.goalId }; // 制造环（b→b）
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
        const root = g(ulid(), { kind: 'intake', origin: { kind: 'human' } });
        const intakeB = g(ulid(), {
            rootGoalId: root.goalId,
            kind: 'intake',
            parent: { type: 'delegation', goalId: root.goalId, stepId: ulid() },
        });
        const work = g(ulid(), {
            rootGoalId: root.goalId,
            parent: { type: 'split', goalId: intakeB.goalId },
        });
        const index = new Map([
            [root.goalId, root],
            [intakeB.goalId, intakeB],
            [work.goalId, work],
        ]);
        expect(validateAttributionChain(work, index)).toEqual({ ok: true });
    });

    it('validateCeilingMonotonicity：兄弟 budget 总和 ≤ parent、ceiling 递减合规', () => {
        const intake: Goal = g(ulid(), {
            kind: 'intake',
            origin: { kind: 'human' },
            permissionCeiling: 'autonomous',
            budget: { maxCostUsd: 1 },
        });
        const s1 = g(ulid(), {
            rootGoalId: intake.goalId,
            permissionCeiling: 'approved',
            budget: { maxCostUsd: 0.6 },
            parent: { type: 'split', goalId: intake.goalId },
        });
        const s2: Goal = g(ulid(), {
            rootGoalId: intake.goalId,
            permissionCeiling: 'read-only',
            budget: { maxCostUsd: 0.4 },
            parent: { type: 'split', goalId: intake.goalId },
        });
        const index = new Map<string, Goal>([
            [intake.goalId, intake],
            [s1.goalId, s1],
            [s2.goalId, s2],
        ]);
        expect(validateCeilingMonotonicity([intake, s1, s2], index)).toEqual({ ok: true });
    });

    it('validateCeilingMonotonicity：子层 ceiling 越权 → 拒绝', () => {
        const parent: Goal = g(ulid(), {
            permissionCeiling: 'draft' as PermissionLevel,
            origin: { kind: 'human' },
        });
        const child = g(ulid(), {
            rootGoalId: parent.goalId,
            permissionCeiling: 'autonomous',
            parent: { type: 'split', goalId: parent.goalId },
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
