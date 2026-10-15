/**
 * experiments-view —— 实验台的 UI 投影与格式化（纯函数，供组件与单测共用）。
 * 契约来源：docs/AB测试设计.md §5/§9.2，与后端 ExperimentView JSON 同形。
 *
 * 只做展示投影：不判语义优劣（对比口径由后端 compareArms 决定并原样呈现）。
 */

import type { GoalTreeSnapshot } from '@mazi/libs';

export type ExperimentStatus = 'created' | 'running' | 'completed' | 'failed' | 'aborted';
export type ExperimentArmStatus = 'pending' | 'running' | 'completed' | 'failed' | 'aborted';
export type ExperimentVerdict = 'A' | 'B' | 'tie' | 'inconclusive';
export type BetterSide = 'A' | 'B' | 'tie' | 'none';

export interface ExperimentVariableView {
    kind: string;
    label: string;
    baseline: unknown;
    treatment: unknown;
}

export interface ExperimentMetricsView {
    ok: boolean;
    status: 'succeeded' | 'failed' | 'aborted';
    tasks: number;
    steps: number;
    toolCalls: number;
    modelRounds: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    costUsd: number;
    durationMs: number;
    ttftMs: number;
    finalAnswer: string;
    finalAnswerChars: number;
    models: string[];
    skills: string[];
    features: Record<string, boolean>;
}

export interface ExperimentArmSpecView {
    label: string;
    modelId?: string;
    skills?: string[];
    features?: Record<string, boolean>;
    permissionCeiling?: string;
    reasoningLevel?: string;
}

export interface ExperimentArmView {
    label: string;
    spec: ExperimentArmSpecView;
    rootGoalId?: string;
    status: ExperimentArmStatus;
    startedAt?: number;
    endedAt?: number;
    metrics?: ExperimentMetricsView;
    error?: string;
}

export interface ComparisonMetricView {
    key: string;
    label: string;
    unit: string;
    a: number | boolean;
    b: number | boolean;
    delta?: number;
    deltaPct?: number;
    better: BetterSide;
}

export interface ExperimentComparisonView {
    metrics: ComparisonMetricView[];
    outputs: { a: string; b: string; identical: boolean };
    execution: string;
    note: string;
}

export interface ExperimentReviewView {
    note: string;
    verdict: ExperimentVerdict;
    at: number;
}

export interface ExperimentView {
    experimentId: string;
    title: string;
    hypothesis?: string;
    input: string;
    workspace?: string;
    baseline: Record<string, unknown>;
    variables: ExperimentVariableView[];
    arms: ExperimentArmView[];
    status: ExperimentStatus;
    createdAt: number;
    startedAt?: number;
    endedAt?: number;
    comparison?: ExperimentComparisonView;
    error?: string;
    reviews: ExperimentReviewView[];
}

export interface ExperimentSummaryView {
    experimentId: string;
    title: string;
    status: ExperimentStatus;
    input: string;
    createdAt: number;
    endedAt?: number;
    variables: ExperimentVariableView[];
    arms: Array<{
        label: string;
        status: ExperimentArmStatus;
        rootGoalId?: string;
        ok?: boolean;
        costUsd?: number;
        durationMs?: number;
    }>;
    reviewCount: number;
}

const ARM_STATUS_LABELS: Record<string, string> = {
    pending: '待执行',
    running: '运行中',
    completed: '完成',
    failed: '失败',
    aborted: '中止',
};

const EXPERIMENT_STATUS_LABELS: Record<string, string> = {
    created: '已定义',
    running: '运行中',
    completed: '已完成',
    failed: '失败',
    aborted: '已中止',
};

const VERDICT_LABELS: Record<string, string> = {
    A: 'A 更优',
    B: 'B 更优',
    tie: '持平',
    inconclusive: '不确定',
};

export function armStatusLabel(status: string): string {
    return ARM_STATUS_LABELS[status] ?? status;
}

export function experimentStatusLabel(status: string): string {
    return EXPERIMENT_STATUS_LABELS[status] ?? status;
}

export function verdictLabel(verdict: string): string {
    return VERDICT_LABELS[verdict] ?? verdict;
}

/** 自变量取值 → 单行文案（未知类型原样展开，保证不丢信息）。 */
export function variableValueText(value: unknown): string {
    if (value === null || value === undefined) return '—';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return value.length === 0 ? '（空）' : value.map(String).join(', ');
    if (typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>);
        return entries.length === 0
            ? '（空）'
            : entries.map(([key, raw]) => key + '=' + String(raw)).join(', ');
    }
    return String(value);
}

/** 自变量一行：kind · 基线 → 处理。 */
export function variableFormula(variable: ExperimentVariableView): string {
    const kind = variable.kind || 'variable';
    return (
        kind +
        ' · ' +
        variableValueText(variable.baseline) +
        ' → ' +
        variableValueText(variable.treatment)
    );
}

/** 数值格式化：成本高精度、毫秒带单位、token 千分位。 */
export function formatMetric(value: number | boolean, unit: string): string {
    if (typeof value === 'boolean') return value ? '成功' : '失败';
    if (!Number.isFinite(value)) return '—';
    if (unit === 'USD') return '$' + value.toFixed(6);
    if (unit === 'ms')
        return value >= 1000 ? (value / 1000).toFixed(2) + 's' : Math.round(value) + 'ms';
    if (unit === 'tok') return value.toLocaleString('en-US');
    return String(Math.round(value));
}

/** Δ 文案：带符号；无 delta（如布尔指标）→ '—'。 */
export function formatDelta(metric: ComparisonMetricView): string {
    if (metric.delta === undefined) return '—';
    const sign = metric.delta > 0 ? '+' : metric.delta < 0 ? '−' : '';
    const magnitude = Math.abs(metric.delta);
    const body =
        metric.unit === 'USD'
            ? magnitude.toFixed(6)
            : metric.unit === 'ms'
              ? String(Math.round(magnitude))
              : String(Number(magnitude.toFixed(2)));
    return sign + body;
}

export function formatDeltaPct(metric: ComparisonMetricView): string {
    if (metric.deltaPct === undefined || !Number.isFinite(metric.deltaPct)) return '—';
    const sign = metric.deltaPct > 0 ? '+' : '';
    return sign + metric.deltaPct.toFixed(1) + '%';
}

export function betterLabel(better: BetterSide): string {
    if (better === 'A') return 'A';
    if (better === 'B') return 'B';
    if (better === 'tie') return '持平';
    return '—';
}

/** 对比结论计数（列表卡片用）：A/B/tie 各多少项。 */
export function comparisonTally(comparison?: ExperimentComparisonView): {
    a: number;
    b: number;
    tie: number;
} {
    const tally = { a: 0, b: 0, tie: 0 };
    for (const metric of comparison?.metrics ?? []) {
        if (metric.better === 'A') tally.a += 1;
        else if (metric.better === 'B') tally.b += 1;
        else if (metric.better === 'tie') tally.tie += 1;
    }
    return tally;
}

/** 臂上「实际生效」的 Feature 标签（只列开启项，按 id 排序）。 */
export function armFeatureLabels(arm: ExperimentArmView): string[] {
    const features = arm.metrics?.features ?? {};
    return Object.entries(features)
        .filter(([, enabled]) => enabled)
        .map(([id]) => id)
        .sort();
}

/** 臂上「实际生效」的配置摘要（模型 / 技能 / 权限 / 推理档）。 */
export function armConfigSummary(arm: ExperimentArmView): string {
    const parts: string[] = [];
    const models = arm.metrics?.models ?? [];
    const model = arm.spec.modelId ?? models[0];
    parts.push('模型 ' + (model || '（默认）'));
    const skills = arm.metrics?.skills ?? arm.spec.skills ?? [];
    parts.push('技能 ' + (skills.length > 0 ? skills.join(', ') : '（全局挂载）'));
    if (arm.spec.permissionCeiling) parts.push('权限 ' + arm.spec.permissionCeiling);
    if (arm.spec.reasoningLevel) parts.push('推理 ' + arm.spec.reasoningLevel);
    return parts.join(' · ');
}

/** 是否已具备并排对比条件（两臂都跑完且有指标）。 */
export function canCompare(view: ExperimentView): boolean {
    return view.comparison !== undefined && view.arms.every((arm) => arm.metrics !== undefined);
}
/* ---- 新建实验表单 → spec（纯函数，便于单测） ---- */

export type ExperimentVariableKind = 'feature' | 'skill' | 'model' | 'permission' | 'reasoning';

export const EXPERIMENT_KIND_LABELS: Record<ExperimentVariableKind, string> = {
    feature: 'Feature 开关',
    skill: 'Skill 集合',
    model: '模型',
    permission: '权限档位',
    reasoning: '推理强度',
};

/** 实验台「新建实验」表单状态（两臂取值按 kind 取用对应字段）。 */
export interface ExperimentFormState {
    title: string;
    hypothesis: string;
    input: string;
    workspace: string;
    kind: ExperimentVariableKind;
    modelA: string;
    modelB: string;
    featureId: string;
    skillA: string;
    skillB: string;
    reasoningA: string;
    reasoningB: string;
    permissionA: string;
    permissionB: string;
}

/** 逗号 / 换行分隔的文本 → 去重列表。 */
export function splitList(text: string): string[] {
    return [
        ...new Set(
            text
                .split(/[,，\n]/)
                .map((item) => item.trim())
                .filter((item) => item.length > 0),
        ),
    ];
}

export interface ExperimentSpecDraft {
    spec?: Record<string, unknown>;
    error?: string;
}

/**
 * 表单 → 实验定义（唯一入口）：同一输入 + 两臂 delta + 一条自变量声明。
 * 只做机械校验（必填项）；后端 validateExperimentSpec 是最终裁决。
 */
export function buildExperimentSpec(form: ExperimentFormState): ExperimentSpecDraft {
    const title = form.title.trim();
    const input = form.input.trim();
    if (title.length === 0) return { error: '请填写实验标题' };
    if (input.length === 0) return { error: '请填写两臂共用的输入' };

    let baseline: unknown;
    let treatment: unknown;
    const armA: Record<string, unknown> = { label: 'A' };
    const armB: Record<string, unknown> = { label: 'B' };

    if (form.kind === 'model') {
        if (form.modelA.length === 0 || form.modelB.length === 0)
            return { error: '请选择两臂模型' };
        baseline = form.modelA;
        treatment = form.modelB;
        armA.modelId = form.modelA;
        armB.modelId = form.modelB;
    } else if (form.kind === 'feature') {
        if (form.featureId.length === 0) return { error: '请选择要对照的 Feature' };
        baseline = false;
        treatment = true;
        armA.features = { [form.featureId]: false };
        armB.features = { [form.featureId]: true };
    } else if (form.kind === 'skill') {
        const skillsA = splitList(form.skillA);
        const skillsB = splitList(form.skillB);
        if (skillsA.length === 0 && skillsB.length === 0) return { error: '至少给一臂一个 Skill' };
        baseline = skillsA;
        treatment = skillsB;
        armA.skills = skillsA;
        armB.skills = skillsB;
    } else if (form.kind === 'reasoning') {
        if (form.reasoningA.length === 0 || form.reasoningB.length === 0) {
            return { error: '请选择两臂推理强度' };
        }
        baseline = form.reasoningA;
        treatment = form.reasoningB;
        armA.reasoningLevel = form.reasoningA;
        armB.reasoningLevel = form.reasoningB;
    } else {
        if (form.permissionA.length === 0 || form.permissionB.length === 0) {
            return { error: '请选择两臂权限档位' };
        }
        baseline = form.permissionA;
        treatment = form.permissionB;
        armA.permissionCeiling = form.permissionA;
        armB.permissionCeiling = form.permissionB;
    }

    const spec: Record<string, unknown> = {
        title,
        input,
        variables: [
            { kind: form.kind, label: EXPERIMENT_KIND_LABELS[form.kind], baseline, treatment },
        ],
        arms: [armA, armB],
    };
    if (form.hypothesis.trim().length > 0) spec.hypothesis = form.hypothesis.trim();
    if (form.workspace.trim().length > 0) spec.workspace = form.workspace.trim();
    return { spec };
}

/* ---- Trace 投影（两臂并排对比用） ---- */

export interface TraceRoundRow {
    index: number;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    durationMs: number;
    answerChars: number;
}

export interface TraceToolRow {
    toolName: string;
    cwd: string;
    output: string;
}

/** 从 Goal 树快照投影模型轮次表（按 roundId 去重，口径与实验指标一致）。 */
export function traceRounds(snapshot: GoalTreeSnapshot | null | undefined): TraceRoundRow[] {
    const steps = snapshot?.goals.flatMap((goal) => goal.tasks).flatMap((task) => task.steps) ?? [];
    const seen = new Set<string>();
    const rows: TraceRoundRow[] = [];
    for (const step of steps) {
        if (step.kind !== 'deliberation') continue;
        const usage = step.usage;
        if (usage?.roundId !== undefined) {
            if (seen.has(usage.roundId)) continue;
            seen.add(usage.roundId);
        }
        rows.push({
            index: rows.length + 1,
            model: usage?.raw?.modelId ?? '—',
            inputTokens: usage?.raw?.inputTokens ?? 0,
            outputTokens: usage?.raw?.outputTokens ?? 0,
            costUsd: usage?.cost?.totalCostUsd ?? 0,
            durationMs: Math.max(0, (step.endedAt ?? step.startedAt) - step.startedAt),
            answerChars: (step.answer ?? step.content ?? '').length,
        });
    }
    return rows;
}

/** 从 Goal 树快照投影工具调用表（Trace 对比的第二张表）。 */
export function traceToolRows(snapshot: GoalTreeSnapshot | null | undefined): TraceToolRow[] {
    const steps = snapshot?.goals.flatMap((goal) => goal.tasks).flatMap((task) => task.steps) ?? [];
    return steps
        .filter((step) => step.kind === 'invocation')
        .map((step) => ({
            toolName: step.toolName ?? '—',
            cwd: step.toolCwd ?? '',
            output: (step.toolOutput ?? step.content ?? '').replace(/\s+/g, ' ').trim(),
        }));
}
