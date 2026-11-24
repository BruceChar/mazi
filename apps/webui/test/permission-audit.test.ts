import { describe, expect, it } from 'vitest';

import {
    ACTOR_OPTIONS,
    RESULT_OPTIONS,
    applyFilters,
    actorLabel,
    resultLabel,
    summarize,
    type PermissionAuditRecord,
} from '../src/scripts/permission-audit.ts';

function record(over: Partial<PermissionAuditRecord>): PermissionAuditRecord {
    return {
        id: over.id ?? 'evt',
        at: over.at ?? 1_700_000_000_000,
        kind: over.kind ?? 'approval.granted',
        actor: over.actor ?? 'user',
        result: over.result ?? 'approved',
        basis: over.basis ?? '',
        ...(over.tool !== undefined ? { tool: over.tool } : {}),
        ...(over.effectClass !== undefined ? { effectClass: over.effectClass } : {}),
        ...(over.stage !== undefined ? { stage: over.stage } : {}),
        ...(over.scope !== undefined ? { scope: over.scope } : {}),
        ...(over.goalId !== undefined ? { goalId: over.goalId } : {}),
        ...(over.stepId !== undefined ? { stepId: over.stepId } : {}),
    };
}

const rows: PermissionAuditRecord[] = [
    record({ id: 'a', actor: 'user', result: 'approved', tool: 'bash', basis: 'user-approved', at: 1000 }),
    record({ id: 'b', actor: 'agent', result: 'denied', tool: 'rm', basis: 'dangerous write', at: 2000 }),
    record({ id: 'c', actor: 'agent', result: 'auto', tool: 'read', basis: 'passthrough', at: 3000 }),
    record({ id: 'd', actor: 'system', result: 'revoked', tool: '', basis: 'revoked token', at: 4000 }),
];

describe('applyFilters', () => {
    it('filters by actor', () => {
        expect(applyFilters(rows, { actor: 'agent' }).map((r) => r.id)).toEqual(['b', 'c']);
    });

    it('filters by result', () => {
        expect(applyFilters(rows, { result: 'denied' }).map((r) => r.id)).toEqual(['b']);
    });

    it('filters by exact tool', () => {
        expect(applyFilters(rows, { tool: 'bash' }).map((r) => r.id)).toEqual(['a']);
    });

    it('matches keyword across tool, effectClass, basis and kind', () => {
        expect(applyFilters(rows, { keyword: 'dangerous' }).map((r) => r.id)).toEqual(['b']);
        expect(applyFilters(rows, { keyword: 'passthrough' }).map((r) => r.id)).toEqual(['c']);
    });

    it('filters by inclusive time range', () => {
        expect(applyFilters(rows, { from: 1500, to: 3500 }).map((r) => r.id)).toEqual(['b', 'c']);
    });

    it('ignores empty filters', () => {
        expect(applyFilters(rows, {}).map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
    });
});

describe('labels', () => {
    it('maps actor and result to Chinese labels', () => {
        expect(actorLabel('user')).toBe('用户');
        expect(actorLabel('agent')).toBe('Agent');
        expect(actorLabel('system')).toBe('系统');
        expect(resultLabel('approved')).toBe('已批准');
        expect(resultLabel('denied')).toBe('已拒绝');
        expect(resultLabel('auto')).toBe('自动放行');
    });

    it('exposes stable option lists', () => {
        expect(ACTOR_OPTIONS.map((o) => o.value)).toEqual(['user', 'agent', 'system']);
        expect(RESULT_OPTIONS.map((o) => o.value)).toContain('approved');
        expect(RESULT_OPTIONS.map((o) => o.value)).toContain('denied');
    });
});

describe('summarize', () => {
    it('counts outcomes by actor/result', () => {
        const s = summarize(rows);
        expect(s.total).toBe(4);
        expect(s.byActor.user).toBe(1);
        expect(s.byActor.agent).toBe(2);
        expect(s.byResult.approved).toBe(1);
        expect(s.byResult.denied).toBe(1);
        expect(s.byResult.auto).toBe(1);
        expect(s.byResult.revoked).toBe(1);
    });

    it('returns zeroed summary for empty input', () => {
        const s = summarize([]);
        expect(s.total).toBe(0);
        expect(s.byActor.user).toBe(0);
        expect(s.byResult.approved).toBe(0);
    });
});
