/**
 * contract-view —— GoalContract / 验收结果的展示投影（纯函数，零 DOM）。
 *
 * 契约是「角色间协议」（docs/core/AHF_CORE_GTS.md §4）：UI 的职责是把承诺
 * 与判定结果并排呈现，不做解释、不替评估器下结论。
 */

import type {
    AcceptanceResultView,
    AcceptanceView,
    ContractConditionView,
    ContractStatusView,
    ContractView,
    GoalNodeView,
    NegotiationView,
} from '@mazi/libs';

/** 条款判定口径：机械可判 / 需 judge / 尚未配置检查器。 */
export type JudgeKind = 'mechanical' | 'semantic' | 'unchecked';

export interface ContractConditionRow {
    id: string;
    text: string;
    judge: JudgeKind;
    judgeLabel: string;
}

export interface ContractSummary {
    conditions: ContractConditionRow[];
    /** 确定性条款占比（0-100；无条款 = 0）。 */
    deterministicPercent: number;
    limits: Array<{ label: string; value: string }>;
    risks: string[];
    forbidden: string[];
    /** 无条款、无上限、无风险、无禁止项 = 空壳契约。 */
    empty: boolean;
}

export interface AcceptanceRow {
    id: string;
    text: string;
    judge: JudgeKind;
    status: 'passed' | 'failed' | 'unchecked';
}

export interface AcceptanceBadge {
    label: string;
    tone: 'ok' | 'fail' | 'muted';
}

/** 防御式数组：后端/旧数据字段可能缺失或形状不符，展示层绝不因此抛错（否则整块 UI 会白屏）。 */
function asArray<T>(value: readonly T[] | null | undefined): readonly T[] {
    return Array.isArray(value) ? value : [];
}

const JUDGE_LABEL: Record<JudgeKind, string> = {
    mechanical: '机械可判',
    semantic: '语义判定',
    unchecked: '尚无检查器',
};

function judgeOf(condition?: ContractConditionView): JudgeKind {
    if (condition === undefined) return 'unchecked';
    if (condition.checkType === 'semantic') return 'semantic';
    return condition.check !== undefined ? 'mechanical' : 'unchecked';
}

/** 契约摘要：条款 + 上限 + 风险 + 禁止项，供 Goal 头部的契约卡片渲染。 */
export function contractSummaryOf(contract?: ContractView | null): ContractSummary {
    const conditions: ContractConditionRow[] = asArray(contract?.successConditions).map(
        (condition) => {
            const judge = judgeOf(condition);
            return {
                id: condition.id,
                text: condition.description || condition.id,
                judge,
                judgeLabel: JUDGE_LABEL[judge],
            };
        },
    );
    const budget = contract?.budget ?? {};
    const termination = contract?.terminationPolicy ?? {};
    const limits: Array<{ label: string; value: string }> = [];
    if (budget.maxCostUsd !== undefined) {
        limits.push({ label: '成本上限', value: `$${budget.maxCostUsd}` });
    }
    const maxSteps = termination.maxSteps ?? budget.maxSteps;
    if (maxSteps !== undefined) limits.push({ label: '最大轮次', value: `${maxSteps} 轮` });
    if (budget.maxTokens !== undefined) {
        limits.push({ label: 'Token 上限', value: String(budget.maxTokens) });
    }
    const timeoutMs = termination.timeoutMs ?? budget.timeoutMs;
    if (timeoutMs !== undefined) {
        limits.push({ label: '超时', value: `${Math.round(timeoutMs / 1000)}s` });
    }
    const risks: string[] = [];
    if (contract?.riskProfile?.hasIrreversibleActions) risks.push('含不可撤回操作');
    if (contract?.riskProfile?.touchesNetwork) risks.push('触网');
    if (contract?.riskProfile?.touchesExternalApi) risks.push('调用外部 API');
    const forbidden = asArray(contract?.forbiddenResources).map(
        (resource) => `${resource?.kind ?? '?'} ${resource?.pattern ?? ''}`,
    );
    return {
        conditions,
        deterministicPercent: Math.round((contract?.deterministicRatio ?? 0) * 100),
        limits,
        risks,
        forbidden,
        empty:
            conditions.length === 0 &&
            limits.length === 0 &&
            risks.length === 0 &&
            forbidden.length === 0,
    };
}

/** Task 验收行：把 acceptance.conditions（条款 id）映射回条款文本与判定状态。 */
export function acceptanceRows(
    acceptance?: AcceptanceView | null,
    contract?: ContractView | null,
    result?: AcceptanceResultView | null,
): AcceptanceRow[] {
    const conditionById = new Map(
        asArray(contract?.successConditions).map((condition) => [condition.id, condition]),
    );
    const statusById = new Map(
        asArray(result?.conditions).map((item) => [item.conditionId, item.status]),
    );
    return asArray(acceptance?.conditions).map((id) => {
        const condition = conditionById.get(id);
        return {
            id,
            text: condition?.description || id,
            judge: judgeOf(condition),
            status: statusById.get(id) ?? 'unchecked',
        };
    });
}

/** 契约条款 + 机械判定状态（Trace 面板的「验证约束」行）。 */
export interface ContractClauseRow extends ContractConditionRow {
    status: 'passed' | 'failed' | 'unchecked';
    detail?: string;
}

export interface ContractTraceTask {
    taskId: string;
    title: string;
    status: string;
    /** 该 Task 锚定的条款（文本 + 判定口径 + 状态）。 */
    acceptance: AcceptanceRow[];
    result: AcceptanceResultView | null;
}

/** 一个 Goal 的契约视图：条款 + 上限 + 验收 + 协商轨迹。 */
export interface ContractTraceView {
    goalId: string;
    statement: string;
    goalStatus: string;
    /** 协商轨迹；未经协商的旧数据为 null。 */
    negotiation: NegotiationView | null;
    summary: ContractSummary;
    conditions: ContractClauseRow[];
    /** 失败条款（当前无可判结果，只列声明）。 */
    failureConditions: string[];
    /** Goal 级契约满足度（评估器机械口径）；未执行/旧数据为 null。 */
    contractStatus: ContractStatusView | null;
    tasks: ContractTraceTask[];
}

/** 契约满足度中文标签。 */
export const CONTRACT_STATE_LABEL: Record<string, string> = {
    satisfied: '契约已满足',
    violated: '契约未满足',
    partial: '部分判定',
    unchecked: '未判定',
};

/** 满足度色调（用于徽标着色）。 */
export function contractStateTone(state?: string | null): 'ok' | 'fail' | 'muted' {
    if (state === 'satisfied') return 'ok';
    if (state === 'violated') return 'fail';
    return 'muted';
}

/** 满足度徽标文本：无条款时明确说"无条款"，不谎报满足。 */
export function contractStateLabel(status?: ContractStatusView | null): string {
    const total = status?.total ?? 0;
    if (status === undefined || status === null || total === 0) return '契约无条款';
    const label = CONTRACT_STATE_LABEL[status.state] ?? status.state;
    return `${label} ${status.passed}/${total}（已判 ${status.evaluated}）`;
}

/**
 * Goal 快照 → Trace 面板的契约区数据。
 * 条款判定状态按 Task 的 acceptanceResult 合并：failed 优先于 passed，优先于 unchecked。
 */
export function contractTraceOf(goals?: GoalNodeView[] | null): ContractTraceView[] {
    return asArray(goals).map((goal) => {
        const statusById = new Map<string, 'passed' | 'failed' | 'unchecked'>();
        const detailById = new Map<string, string>();
        for (const task of asArray(goal?.tasks)) {
            for (const item of asArray(task?.acceptanceResult?.conditions)) {
                const current = statusById.get(item.conditionId);
                if (current === undefined || (current !== 'failed' && item.status === 'failed')) {
                    statusById.set(item.conditionId, item.status);
                } else if (item.status === 'passed' && current === 'unchecked') {
                    statusById.set(item.conditionId, 'passed');
                }
                if (item.detail !== undefined) detailById.set(item.conditionId, item.detail);
            }
        }
        const summary = contractSummaryOf(goal.contract);
        return {
            goalId: goal.goalId,
            statement: goal.statement,
            goalStatus: goal.status,
            negotiation: goal.negotiation ?? null,
            summary,
            conditions: summary.conditions.map((condition) => {
                const detail = detailById.get(condition.id);
                return {
                    ...condition,
                    status: statusById.get(condition.id) ?? 'unchecked',
                    ...(detail !== undefined ? { detail } : {}),
                };
            }),
            failureConditions: asArray(goal.contract?.failureConditions).map(
                (condition) => condition?.description || condition?.id || '未命名失败条件',
            ),
            contractStatus: goal.contractStatus ?? null,
            tasks: asArray(goal.tasks).map((task) => ({
                taskId: task.taskId,
                title: task.title,
                status: task.status,
                acceptance: acceptanceRows(task.acceptance, goal.contract, task.acceptanceResult),
                result: task.acceptanceResult ?? null,
            })),
        };
    });
}

/**
 * 待答复的协商：从契约区里挑出**未决且无答复**的 negotiate / escalate（取最近一个）。
 * dismissed 是用户已主动关掉的 goalId，不再打扰。
 */
export function pendingNegotiationOf(
    contracts: readonly ContractTraceView[] | null | undefined,
    dismissed?: ReadonlySet<string> | null,
): ContractTraceView | null {
    const list = asArray(contracts);
    for (let index = list.length - 1; index >= 0; index -= 1) {
        const entry = list[index];
        const negotiation = entry?.negotiation;
        if (!negotiation) continue;
        if (negotiation.resolved || asArray(negotiation.answers).length > 0) continue;
        if (negotiation.route !== 'negotiate' && negotiation.route !== 'escalate') continue;
        if (dismissed?.has(entry.goalId)) continue;
        return entry;
    }
    return null;
}

/** 协商路线 → 中文标签（Trace 面板展示）。 */
export const ROUTE_LABEL: Record<string, string> = {
    direct: '直答（不执行）',
    confirmed: '已确认（直接冻结）',
    negotiate: '协商中（待答复）',
    escalate: '升级（待人决）',
    fallback: '默认执行（无解析模型）',
};

/** Task 验收徽标：只有机械判定事实才给通过/不通过结论。 */
export function acceptanceBadge(result?: AcceptanceResultView | null): AcceptanceBadge | null {
    if (result === undefined || result === null || result.total === 0) return null;
    const failed = asArray(result.conditions).filter((item) => item.status === 'failed').length;
    if (!result.passed || failed > 0) {
        return { label: `机械验收未通过（${failed} 条款失败）`, tone: 'fail' };
    }
    if (result.evaluated < result.total) {
        return {
            label: `已判 ${result.evaluated}/${result.total} · 其余需 judge`,
            tone: 'muted',
        };
    }
    return { label: `机械验收通过 ${result.evaluated}/${result.total}`, tone: 'ok' };
}
