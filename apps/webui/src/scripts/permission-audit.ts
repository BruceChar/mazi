/**
 * 权限审计面板（R3）前端纯逻辑：记录类型、筛选、标签与汇总。
 *
 * 数据来自 GET /api/permissions/audit（core extractPermissionEvents 抽取），
 * 本模块只做客户端二次筛选与展示格式化，不发起请求。所有事件只追加。
 */

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

export interface PermissionAuditFilter {
    actor?: PermissionActor | '';
    result?: PermissionResult | '';
    tool?: string;
    keyword?: string;
    from?: number;
    to?: number;
}

export interface PermissionSummary {
    total: number;
    byActor: Record<PermissionActor, number>;
    byResult: Record<PermissionResult, number>;
}

export const ACTOR_OPTIONS: ReadonlyArray<{ value: PermissionActor; label: string }> = [
    { value: 'user', label: '用户' },
    { value: 'agent', label: 'Agent' },
    { value: 'system', label: '系统' },
];

export const RESULT_OPTIONS: ReadonlyArray<{ value: PermissionResult; label: string }> = [
    { value: 'approved', label: '已批准' },
    { value: 'denied', label: '已拒绝' },
    { value: 'pending', label: '待审批' },
    { value: 'auto', label: '自动放行' },
    { value: 'cancelled', label: '已取消' },
    { value: 'revoked', label: '已撤销' },
    { value: 'hit', label: '记忆命中' },
];

const ACTOR_LABELS: Record<PermissionActor, string> = {
    user: '用户',
    agent: 'Agent',
    system: '系统',
};

const RESULT_LABELS: Record<PermissionResult, string> = {
    approved: '已批准',
    denied: '已拒绝',
    pending: '待审批',
    auto: '自动放行',
    cancelled: '已取消',
    revoked: '已撤销',
    hit: '记忆命中',
};

export function actorLabel(actor: PermissionActor): string {
    return ACTOR_LABELS[actor] ?? actor;
}

export function resultLabel(result: PermissionResult): string {
    return RESULT_LABELS[result] ?? result;
}

function haystack(record: PermissionAuditRecord): string {
    return [record.tool, record.effectClass, record.basis, record.kind, record.scope]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
}

export function applyFilters(
    records: PermissionAuditRecord[],
    filter: PermissionAuditFilter,
): PermissionAuditRecord[] {
    const keyword = filter.keyword?.trim().toLowerCase();
    return records.filter((record) => {
        if (filter.actor && record.actor !== filter.actor) return false;
        if (filter.result && record.result !== filter.result) return false;
        if (filter.tool && record.tool !== filter.tool) return false;
        if (filter.from !== undefined && record.at < filter.from) return false;
        if (filter.to !== undefined && record.at > filter.to) return false;
        if (keyword && !haystack(record).includes(keyword)) return false;
        return true;
    });
}

function emptyByActor(): Record<PermissionActor, number> {
    return { user: 0, agent: 0, system: 0 };
}

function emptyByResult(): Record<PermissionResult, number> {
    return {
        approved: 0,
        denied: 0,
        pending: 0,
        auto: 0,
        cancelled: 0,
        revoked: 0,
        hit: 0,
    };
}

export function summarize(records: PermissionAuditRecord[]): PermissionSummary {
    const byActor = emptyByActor();
    const byResult = emptyByResult();
    for (const record of records) {
        byActor[record.actor] += 1;
        byResult[record.result] += 1;
    }
    return { total: records.length, byActor, byResult };
}
