import { describe, expect, it } from 'vitest';

import {
    KIND_OPTIONS,
    RESULT_OPTIONS,
    applyBehaviorFilter,
    authorizationEvidence,
    classifyResult,
    selectBehaviors,
    summarize,
    type BehaviorRow,
} from '../src/scripts/behavior-audit.ts';

function row(over: Partial<BehaviorRow> & { ts: number; type: BehaviorRow['type'] }): BehaviorRow {
    return {
        data: {},
        ...over,
    } as BehaviorRow;
}

describe('selectBehaviors', () => {
    it('只保留授权与反馈，剔除提问/审批锚点/设置/会话', () => {
        const all = [
            row({ ts: 1, type: 'input', data: { text: '帮我写代码' } }),
            row({ ts: 2, type: 'approval', data: { capability: 'net.fetch', summary: '审批请求' } }),
            row({ ts: 3, type: 'authorization', data: { decision: 'granted' } }),
            row({ ts: 4, type: 'feedback', data: { kind: 'rating', rating: 5 } }),
            row({ ts: 5, type: 'setting', data: {} }),
            row({ ts: 6, type: 'session', data: {} }),
        ];
        const kept = selectBehaviors(all);
        expect(kept.map((b) => b.type)).toEqual(['authorization', 'feedback']);
    });
});

describe('classifyResult', () => {
    it('授权 granted→allowed，denied→denied', () => {
        expect(classifyResult(row({ ts: 1, type: 'authorization', data: { decision: 'granted' } }))).toBe('allowed');
        expect(classifyResult(row({ ts: 1, type: 'authorization', data: { decision: 'denied' } }))).toBe('denied');
    });
    it('反馈 rating 高→赞，低→踩', () => {
        expect(classifyResult(row({ ts: 1, type: 'feedback', data: { kind: 'rating', rating: 5 } }))).toBe('up');
        expect(classifyResult(row({ ts: 1, type: 'feedback', data: { kind: 'rating', rating: 1 } }))).toBe('down');
    });
    it('无法归类返回 null', () => {
        expect(classifyResult(row({ ts: 1, type: 'feedback', data: { kind: 'interrupt' } }))).toBeNull();
    });
});

describe('applyBehaviorFilter', () => {
    const rows = [
        row({ ts: 1000, type: 'authorization', data: { decision: 'granted' } }),
        row({ ts: 2000, type: 'authorization', data: { decision: 'denied' } }),
        row({ ts: 3000, type: 'feedback', data: { kind: 'rating', rating: 5 } }),
        row({ ts: 4000, type: 'feedback', data: { kind: 'rating', rating: 1 } }),
    ];

    it('按 kind 筛选', () => {
        expect(applyBehaviorFilter(rows, { kind: 'authorization' }).map((r) => r.ts)).toEqual([1000, 2000]);
        expect(applyBehaviorFilter(rows, { kind: 'feedback' }).map((r) => r.ts)).toEqual([3000, 4000]);
    });

    it('按 result 筛选', () => {
        expect(applyBehaviorFilter(rows, { result: 'denied' }).map((r) => r.ts)).toEqual([2000]);
        expect(applyBehaviorFilter(rows, { result: 'up' }).map((r) => r.ts)).toEqual([3000]);
    });

    it('按时间范围 from/to 过滤（闭区间）', () => {
        expect(applyBehaviorFilter(rows, { from: 1500, to: 3500 }).map((r) => r.ts)).toEqual([2000, 3000]);
    });
});

describe('summarize', () => {
    it('统计允许/拒绝/赞/踩', () => {
        const rows = [
            row({ ts: 1, type: 'authorization', data: { decision: 'granted' } }),
            row({ ts: 2, type: 'authorization', data: { decision: 'granted' } }),
            row({ ts: 3, type: 'authorization', data: { decision: 'denied' } }),
            row({ ts: 4, type: 'feedback', data: { kind: 'rating', rating: 5 } }),
            row({ ts: 5, type: 'feedback', data: { kind: 'rating', rating: 1 } }),
        ];
        expect(summarize(rows)).toEqual({ total: 5, allowed: 2, denied: 1, up: 1, down: 1 });
    });
});

describe('authorizationEvidence', () => {
    it('从 ref 指向的审批锚点提取工具/摘要/invocationId，并合并自身 decision/scope/latencyMs', () => {
        const auth = row({
            ts: 100,
            type: 'authorization',
            ref: { ts: 90 },
            data: { decision: 'granted', scope: 'once', latencyMs: 3355 },
        });
        const approval = row({
            ts: 90,
            type: 'approval',
            data: {
                invocationId: 'inv-1',
                capability: 'net.fetch',
                summary: '调用 net.fetch 访问 https://x.com',
            },
        });
        const ev = authorizationEvidence(auth, new Map([[90, approval]]));
        expect(ev).toEqual({
            decision: 'granted',
            capability: 'net.fetch',
            summary: '调用 net.fetch 访问 https://x.com',
            invocationId: 'inv-1',
            scope: 'once',
            latencyMs: 3355,
        });
    });

    it('无锚点时仍返回自身字段', () => {
        const auth = row({
            ts: 100,
            type: 'authorization',
            data: { decision: 'denied', scope: 'session' },
        });
        expect(authorizationEvidence(auth, new Map())).toEqual({
            decision: 'denied',
            capability: '',
            summary: '',
            invocationId: '',
            scope: 'session',
            latencyMs: undefined,
        });
    });
});

describe('选项常量', () => {
    it('类型与结果选项完整', () => {
        expect(KIND_OPTIONS.map((o) => o.value)).toEqual(['authorization', 'feedback']);
        expect(RESULT_OPTIONS.map((o) => o.value)).toEqual(['allowed', 'denied', 'up', 'down']);
    });
});
