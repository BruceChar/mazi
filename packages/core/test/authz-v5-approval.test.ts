import { describe, expect, it } from 'vitest';

import { settleApproval, type V5ApprovalDecision } from '../src/authz/v5/approval.js';
import { BlockedStore } from '../src/authz/v5/blocked-store.js';
import { MemoryStore } from '../src/authz/v5/memory-store.js';

function wire() {
    return { store: new MemoryStore(), blocked: new BlockedStore(), now: 1_000 };
}

describe('审批响应集合（§2 / M5）', () => {
    it('granted session → 记忆命中；once 不跨次', () => {
        const { store, blocked, now } = wire();
        settleApproval(
            { decision: 'granted', scope: 'session' },
            { key: 'k', sessionId: 'c1', hazardLimited: false, now },
            store,
            blocked,
        );
        expect(store.has('k', { sessionId: 'c1' })).toBe(true);

        const { store: onceStore, blocked: onceBlocked, now: t } = wire();
        settleApproval(
            { decision: 'granted', scope: 'once' },
            { key: 'k2', sessionId: 'c1', hazardLimited: false, now: t },
            onceStore,
            onceBlocked,
        );
        expect(onceStore.has('k2', { sessionId: 'c1' })).toBe(false);
    });

    it('granted project → 全局记忆；hazard 受限条目拒绝 project', () => {
        const { store, blocked, now } = wire();
        settleApproval(
            { decision: 'granted', scope: 'project' },
            { key: 'k', hazardLimited: false, now },
            store,
            blocked,
        );
        expect(store.has('k', {})).toBe(true);

        expect(() =>
            settleApproval(
                { decision: 'granted', scope: 'project' },
                { key: 'hk', hazardLimited: true, now },
                store,
                blocked,
            ),
        ).toThrow();
    });

    it('rejected → 进红线 blocked', () => {
        const { store, blocked, now } = wire();
        settleApproval(
            { decision: 'rejected', reason: '不要这个' },
            { key: 'x', hazardLimited: false, now },
            store,
            blocked,
        );
        expect(blocked.has('x')).toBe(true);
    });

    it('correction 事后纠正被接受（交 M6 闭环）', () => {
        const { store, blocked, now } = wire();
        const decision: V5ApprovalDecision = { decision: 'correction', reason: '误自动了' };
        expect(() =>
            settleApproval(decision, { key: 'c', hazardLimited: false, now }, store, blocked),
        ).not.toThrow();
    });

    it('typedConfirm 标记 hazard 持久化（键入确认）', () => {
        const { store, blocked, now } = wire();
        settleApproval(
            { decision: 'granted', scope: 'session', typedConfirm: true },
            { key: 'tc', sessionId: 'c1', hazardLimited: true, now },
            store,
            blocked,
        );
        expect(store.has('tc', { sessionId: 'c1' })).toBe(true);
    });
});
