import { describe, expect, it } from 'vitest';

import { authz } from '@mazi/core';

import { V5RuntimeContext } from '../src/tool-gateway/v5-context.js';

type Op = authz.Op;

function op(fields: Partial<Op> = {}): Op {
    return {
        action: 'exec',
        target: 'pnpm test',
        object: 'build_artifact',
        data: 'clean',
        q1: 'reversible',
        envelope: false,
        originChain: false,
        targetFresh: false,
        channel: 'ui_user',
        attested: 'verbatim',
        unparsed: false,
        ...fields,
    };
}

describe('V5RuntimeContext 决策上下文组装（R2）', () => {
    it('rejected 落红线 → isBlocked', () => {
        const ctx = new V5RuntimeContext({ sessionId: 'c1' });
        ctx.blocked.add('pnpm test');
        expect(ctx.decisionContext().isBlocked(op())).toBe(true);
    });

    it('granted session 落记忆 → memoryHit', () => {
        const ctx = new V5RuntimeContext({ sessionId: 'c1' });
        ctx.memory.remember({ key: 'pnpm test', scope: 'session', sessionId: 'c1', createdAt: 0, hazardLimited: false });
        expect(ctx.decisionContext().memoryHit(op())).toBe(true);
        expect(ctx.decisionContext().memoryHit(op({ target: 'other' }))).toBe(false);
    });

    it('routine 训练 5+ 零纠正 → routineHit；hazard 时 false', () => {
        const ctx = new V5RuntimeContext();
        for (let i = 0; i < 5; i++) {
            ctx.routine.observe({ action: 'exec', objectClass: 'build_artifact', targetBinding: 'pnpm test', q1: 'reversible' });
        }
        expect(ctx.decisionContext().routineHit(op())).toBe(true);
        expect(ctx.decisionContext().routineHit(op({ q1: 'irreversible' }))).toBe(false);
    });

    it('passthrough：verbatim + round_clean → true；round_clean=false → false', () => {
        const clean = new V5RuntimeContext({ roundClean: true });
        expect(clean.decisionContext().passthrough(op())).toBe(true);
        const dirty = new V5RuntimeContext({ roundClean: false });
        expect(dirty.decisionContext().passthrough(op())).toBe(false);
    });

    it('七行链端到端：直通命中 → auto，默认 → ask', () => {
        const ctx = new V5RuntimeContext({ roundClean: true });
        expect(authz.decide(op(), ctx.decisionContext())).toBe('auto');
        expect(authz.decide(op({ attested: 'none', target: 'new-cmd' }), ctx.decisionContext())).toBe('ask');
    });
});
