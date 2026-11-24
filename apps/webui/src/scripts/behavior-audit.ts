/**
 * behavior-audit — 行为分析子视图（授权 / 点赞踩）的纯逻辑：类型收口、结果归类、
 * 筛选与汇总、授权证据链提取。api/webui 不共享此模块，仅 WebUI 使用。
 *
 * 行为流里的 `approval` 是 harness 发起的审批锚点（非用户行为），不单独成行，
 * 由授权行经 ref.ts 内联其工具/摘要/invocationId。
 */

/** 行为分析只保留的两类用户行为。 */
export type BehaviorKind = 'authorization' | 'feedback';

/** 归类结果：授权 允许/拒绝，反馈 赞/踩。 */
export type BehaviorResult = 'allowed' | 'denied' | 'up' | 'down';

/** 行为行（与后端 UserBehaviorView 对齐，宽松结构）。 */
export interface BehaviorRow {
    ts: number;
    type: string;
    ref?: { ts: number; anchor?: Record<string, unknown> };
    rootGoalId?: string;
    conversationId?: string;
    data: Record<string, unknown>;
}

export interface BehaviorFilter {
    kind?: BehaviorKind | '';
    result?: BehaviorResult | '';
    from?: number;
    to?: number;
}

export const KIND_OPTIONS: ReadonlyArray<{ value: BehaviorKind; label: string }> = [
    { value: 'authorization', label: '授权' },
    { value: 'feedback', label: '反馈' },
];

export const RESULT_OPTIONS: ReadonlyArray<{ value: BehaviorResult; label: string }> = [
    { value: 'allowed', label: '允许' },
    { value: 'denied', label: '拒绝' },
    { value: 'up', label: '赞' },
    { value: 'down', label: '踩' },
];

/** 只保留授权与反馈；审批锚点、提问、设置、会话均不单独成行。 */
export function selectBehaviors(rows: readonly BehaviorRow[]): BehaviorRow[] {
    return rows.filter((row) => row.type === 'authorization' || row.type === 'feedback');
}

/** 把单条行为归类为结果；无法归类返回 null。 */
export function classifyResult(row: BehaviorRow): BehaviorResult | null {
    if (row.type === 'authorization') {
        const decision = row.data.decision;
        if (decision === 'granted') return 'allowed';
        if (decision === 'denied') return 'denied';
        return null;
    }
    if (row.type === 'feedback' && row.data.kind === 'rating') {
        const rating = Number(row.data.rating);
        if (rating >= 4) return 'up';
        if (rating <= 2) return 'down';
    }
    return null;
}

/** 按类型 / 结果 / 时间范围（闭区间）筛选。 */
export function applyBehaviorFilter(
    rows: readonly BehaviorRow[],
    filter: BehaviorFilter,
): BehaviorRow[] {
    return selectBehaviors(rows).filter((row) => {
        if (filter.kind && row.type !== filter.kind) return false;
        if (filter.result && classifyResult(row) !== filter.result) return false;
        if (filter.from !== undefined && row.ts < filter.from) return false;
        if (filter.to !== undefined && row.ts > filter.to) return false;
        return true;
    });
}

export interface BehaviorSummary {
    total: number;
    allowed: number;
    denied: number;
    up: number;
    down: number;
}

/** 统计允许 / 拒绝 / 赞 / 踩数量。 */
export function summarize(rows: readonly BehaviorRow[]): BehaviorSummary {
    const summary: BehaviorSummary = { total: rows.length, allowed: 0, denied: 0, up: 0, down: 0 };
    for (const row of rows) {
        const result = classifyResult(row);
        if (result === 'allowed') summary.allowed += 1;
        else if (result === 'denied') summary.denied += 1;
        else if (result === 'up') summary.up += 1;
        else if (result === 'down') summary.down += 1;
    }
    return summary;
}

/** 授权证据链：自身 decision/scope/latencyMs + ref 锚点的工具/摘要/invocationId。 */
export interface AuthorizationEvidence {
    decision: string;
    capability: string;
    summary: string;
    invocationId: string;
    scope: string;
    latencyMs: number | undefined;
}

export function authorizationEvidence(
    auth: BehaviorRow,
    approvalByTs: ReadonlyMap<number, BehaviorRow>,
): AuthorizationEvidence {
    const anchor = auth.ref ? approvalByTs.get(auth.ref.ts) : undefined;
    const data = auth.data;
    const anchorData = anchor?.data ?? {};
    return {
        decision: typeof data.decision === 'string' ? data.decision : '',
        capability: typeof anchorData.capability === 'string' ? anchorData.capability : '',
        summary: typeof anchorData.summary === 'string' ? anchorData.summary : '',
        invocationId: typeof anchorData.invocationId === 'string' ? anchorData.invocationId : '',
        scope: typeof data.scope === 'string' ? data.scope : '',
        latencyMs: typeof data.latencyMs === 'number' ? data.latencyMs : undefined,
    };
}

/** 结果中文标签。 */
export function resultLabel(result: BehaviorResult): string {
    return RESULT_OPTIONS.find((opt) => opt.value === result)?.label ?? result;
}
