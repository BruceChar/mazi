import { describe, expect, it } from 'vitest';

import type { HarnessEvent } from '../src/observability.js';
import {
    extractPermissionEvents,
    filterPermissionEvents,
    type PermissionAuditRecord,
} from '../src/authz/v5/audit-history.js';

function event(fields: Partial<HarnessEvent> & Pick<HarnessEvent, 'type' | 'timestamp'>): HarnessEvent {
    return {
        eventId: fields.eventId ?? `ev-${fields.timestamp}`,
        type: fields.type,
        timestamp: fields.timestamp,
        attributes: {},
        ...fields,
    } as HarnessEvent;
}

describe('extractPermissionEvents 权限审计抽取（R3 数据层）', () => {
    it('用户批准 → approved/user；agent 自动放行 → auto/agent', () => {
        const events: HarnessEvent[] = [
            event({
                type: 'approval.granted',
                timestamp: 2,
                actor: 'human',
                attributes: { 'harness.approval_scope': 'session', 'harness.approval_effect_class': 'fs.write.workspace' },
                payload: { scope: 'session' },
            }),
            event({
                type: 'policy.check',
                timestamp: 1,
                actor: 'model',
                attributes: { 'harness.gateway_effect_class': 'fs.read.workspace', 'harness.gateway_stage': 'supply-check' },
                payload: { tool: 'rg', stages: [{ stage: 'supply-check', decision: 'allowed' }] },
            }),
        ];
        const records = extractPermissionEvents(events);
        expect(records).toHaveLength(2);
        const granted = records.find((r) => r.result === 'approved') as PermissionAuditRecord;
        expect(granted.actor).toBe('user');
        expect(granted.scope).toBe('session');
        const auto = records.find((r) => r.result === 'auto') as PermissionAuditRecord;
        expect(auto.actor).toBe('agent');
        expect(auto.tool).toBe('rg');
    });

    it('拒绝 → denied/agent；请求 → pending；取消 → cancelled；记忆命中 → hit；撤销 → revoked', () => {
        const events: HarnessEvent[] = [
            event({ type: 'policy.denied', timestamp: 1, actor: 'harness', payload: { tool: 'rm', code: 'HARD_FLOOR', detail: '系统毁灭' } }),
            event({ type: 'approval.requested', timestamp: 2, actor: 'harness', payload: { tool: 'xh' } }),
            event({ type: 'approval.cancelled', timestamp: 3, actor: 'system' }),
            event({ type: 'approval.hit', timestamp: 4, actor: 'harness' }),
            event({ type: 'approval.revoked', timestamp: 5, actor: 'human' }),
        ];
        const results = extractPermissionEvents(events).map((r) => r.result);
        expect(results).toEqual(['denied', 'pending', 'cancelled', 'hit', 'revoked']);
    });

    it('非权限事件被忽略', () => {
        const events: HarnessEvent[] = [
            event({ type: 'llm.response', timestamp: 1 }),
            event({ type: 'tool.result', timestamp: 2 }),
            event({ type: 'policy.check', timestamp: 3, actor: 'model', payload: { tool: 'rg' } }),
        ];
        expect(extractPermissionEvents(events)).toHaveLength(1);
    });

    it('决策依据保留：stage 链 / 原因码 / 拒绝理由', () => {
        const records = extractPermissionEvents([
            event({
                type: 'policy.denied',
                timestamp: 1,
                actor: 'harness',
                payload: { tool: 'rm', code: 'HARD_FLOOR', detail: '系统毁灭', stages: [{ stage: 'risk-check', decision: 'denied' }] },
            }),
        ]);
        expect(records[0].basis).toContain('HARD_FLOOR');
        expect(records[0].basis).toContain('系统毁灭');
    });
});

describe('filterPermissionEvents 筛选', () => {
    const records: PermissionAuditRecord[] = [
        { id: '1', at: 1, kind: 'policy.check', actor: 'agent', result: 'auto', tool: 'rg', basis: 'read', effectClass: 'fs.read.workspace' },
        { id: '2', at: 2, kind: 'approval.granted', actor: 'user', result: 'approved', tool: 'xh', basis: 'user', effectClass: 'net.fetch', scope: 'session' },
        { id: '3', at: 3, kind: 'policy.denied', actor: 'agent', result: 'denied', tool: 'rm', basis: 'floor' },
    ];

    it('按角色筛选 user / agent', () => {
        expect(filterPermissionEvents(records, { actor: 'user' })).toHaveLength(1);
        expect(filterPermissionEvents(records, { actor: 'agent' })).toHaveLength(2);
    });

    it('按结果筛选', () => {
        expect(filterPermissionEvents(records, { result: 'denied' })).toHaveLength(1);
        expect(filterPermissionEvents(records, { result: 'auto' })).toHaveLength(1);
    });

    it('按工具名与关键词筛选；时间范围过滤', () => {
        expect(filterPermissionEvents(records, { tool: 'xh' })).toHaveLength(1);
        expect(filterPermissionEvents(records, { keyword: 'net.fetch' })).toHaveLength(1);
        expect(filterPermissionEvents(records, { from: 2, to: 3 })).toHaveLength(2);
    });
});
