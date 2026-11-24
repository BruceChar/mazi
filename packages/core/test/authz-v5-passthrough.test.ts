import { describe, expect, it } from 'vitest';

import { decide, type DecisionContext, type Op } from '../src/authz/v5/decision.js';
import { isPassthrough } from '../src/authz/v5/attest.js';
import { BlockedStore } from '../src/authz/v5/blocked-store.js';

function op(fields: Partial<Op> = {}): Op {
    return {
        action: 'exec',
        target: 'npm test',
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

const BASE_CTX: DecisionContext = {
    isBlocked: () => false,
    memoryHit: () => false,
    routineHit: () => false,
    passthrough: () => false,
};

describe('passthrough 直通（§7/D15）', () => {
    it('§16 #10：逐字点名 + 真人通道 + round_clean + 非 hazard → 当次 auto', () => {
        const candidate = op();
        expect(isPassthrough(candidate, { roundClean: true })).toBe(true);
        expect(decide(candidate, { ...BASE_CTX, passthrough: () => true })).toBe('auto');
    });

    it('§16 #11："按 README 执行" attested=none → 不直通，落 ask', () => {
        const candidate = op({ attested: 'none' });
        expect(isPassthrough(candidate, { roundClean: true })).toBe(false);
        expect(decide(candidate, BASE_CTX)).toBe('ask');
    });

    it('Agent 通道 → 不直通', () => {
        expect(isPassthrough(op({ channel: 'agent' }), { roundClean: true })).toBe(false);
    });

    it('本轮有污点（round_clean=false）→ 不直通', () => {
        expect(isPassthrough(op(), { roundClean: false })).toBe(false);
    });

    it('hazard 点名仍问一次：verbatim 也不直通', () => {
        const candidate = op({ q1: 'irreversible' });
        expect(isPassthrough(candidate, { roundClean: true })).toBe(false);
        expect(decide(candidate, { ...BASE_CTX, passthrough: () => true })).toBe('ask');
    });
});

describe('blocked 红线（§1）', () => {
    it('显式拒绝过的操作再次出现 → ask，即使 memory 命中', () => {
        const store = new BlockedStore();
        store.add('npm test');
        const ctx: DecisionContext = {
            ...BASE_CTX,
            isBlocked: (candidate) => store.has(candidate.target),
            memoryHit: () => true,
        };
        expect(decide(op(), ctx)).toBe('ask');
    });

    it('撤销红线后不再拦截', () => {
        const store = new BlockedStore();
        store.add('npm test');
        store.remove('npm test');
        const ctx: DecisionContext = {
            ...BASE_CTX,
            isBlocked: (candidate) => store.has(candidate.target),
        };
        expect(decide(op(), ctx)).not.toBe('deny');
    });
});
