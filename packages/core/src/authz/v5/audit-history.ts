/**
 * V5 权限审计历史（R3 数据层）。
 *
 * 从事件流抽取全部权限相关事件（用户批准 / 拒绝 / 取消 / 记忆命中 / agent
 * 自动放行 / 策略拒绝 / 撤销），保留角色、结果、工具、效果类、决策依据
 * （stage 链 / 原因码 / 理由）、作用域与上下文标识，并提供角色/结果/工具/
 * 关键词/时间范围筛选。所有事件只追加，供审计面板展示。
 */

import type { HarnessEvent } from '../../observability.js';

export type PermissionActor = 'user' | 'agent' | 'system';

export type PermissionResult =
    | 'approved'
    | 'denied'
    | 'pending'
    | 'auto'
    | 'cancelled'
    | 'revoked'
    | 'hit';

export interface PermissionAuditRecord {
    id: string;
    at: number;
    kind: string;
    actor: PermissionActor;
    result: PermissionResult;
    tool?: string;
    effectClass?: string;
    stage?: string;
    /** 决策依据：stage 链 / 原因码 / 拒绝理由。 */
    basis: string;
    scope?: string;
    goalId?: string;
    stepId?: string;
}

export interface PermissionFilter {
    actor?: PermissionActor;
    result?: PermissionResult;
    tool?: string;
    keyword?: string;
    from?: number;
    to?: number;
}

const PERMISSION_KINDS = new Set([
    'policy.check',
    'policy.denied',
    'approval.requested',
    'approval.granted',
    'approval.cancelled',
    'approval.hit',
    'approval.revoked',
]);

function actorOf(event: HarnessEvent): PermissionActor {
    if (event.actor === 'human') return 'user';
    if (event.actor === 'system') return 'system';
    return 'agent';
}

function resultOf(kind: string): PermissionResult {
    switch (kind) {
        case 'approval.granted':
            return 'approved';
        case 'approval.requested':
            return 'pending';
        case 'approval.cancelled':
            return 'cancelled';
        case 'approval.hit':
            return 'hit';
        case 'approval.revoked':
            return 'revoked';
        case 'policy.denied':
            return 'denied';
        default:
            return 'auto';
    }
}

function basisOf(event: HarnessEvent): string {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof payload.code === 'string') parts.push(payload.code);
    if (typeof payload.detail === 'string') parts.push(payload.detail);
    const stages = payload.stages;
    if (Array.isArray(stages)) {
        for (const stage of stages) {
            if (stage !== null && typeof stage === 'object' && 'stage' in stage) {
                parts.push(String((stage as { stage: unknown }).stage));
            }
        }
    }
    const stage = event.attributes['harness.gateway_stage'];
    if (typeof stage === 'string') parts.push(stage);
    return parts.join(' / ');
}

export function extractPermissionEvents(events: HarnessEvent[]): PermissionAuditRecord[] {
    const records: PermissionAuditRecord[] = [];
    for (const event of events) {
        if (!PERMISSION_KINDS.has(event.type)) continue;
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        const effectClass = (event.attributes['harness.gateway_effect_class'] ??
            event.attributes['harness.approval_effect_class']) as string | undefined;
        records.push({
            id: event.eventId,
            at: event.timestamp,
            kind: event.type,
            actor: actorOf(event),
            result: resultOf(event.type),
            ...(typeof payload.tool === 'string' ? { tool: payload.tool } : {}),
            ...(effectClass !== undefined ? { effectClass } : {}),
            ...(typeof event.attributes['harness.gateway_stage'] === 'string'
                ? { stage: event.attributes['harness.gateway_stage'] as string }
                : {}),
            basis: basisOf(event),
            ...(typeof (event.attributes['harness.approval_scope'] ?? payload.scope) === 'string'
                ? { scope: event.attributes['harness.approval_scope'] as string }
                : {}),
            ...(event.goalId !== undefined ? { goalId: event.goalId } : {}),
            ...(event.stepId !== undefined ? { stepId: event.stepId } : {}),
        });
    }
    return records;
}

export function filterPermissionEvents(
    records: PermissionAuditRecord[],
    filter: PermissionFilter,
): PermissionAuditRecord[] {
    return records.filter((record) => {
        if (filter.actor !== undefined && record.actor !== filter.actor) return false;
        if (filter.result !== undefined && record.result !== filter.result) return false;
        if (filter.tool !== undefined && record.tool !== filter.tool) return false;
        if (filter.from !== undefined && record.at < filter.from) return false;
        if (filter.to !== undefined && record.at > filter.to) return false;
        if (filter.keyword !== undefined) {
            const haystack = [record.tool, record.effectClass, record.basis, record.kind]
                .filter(Boolean)
                .join(' ')
                .toLowerCase();
            if (!haystack.includes(filter.keyword.toLowerCase())) return false;
        }
        return true;
    });
}
