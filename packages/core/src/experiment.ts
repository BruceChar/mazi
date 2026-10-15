/**
 * Experiment（对照实验）契约 —— docs/AB测试设计.md §5。
 *
 * 一次实验 = 同一输入 / 同一工作区 / 两臂，只改 variables[] 声明的自变量。
 * 对比只做确定性比较：能用代码判断的绝不交给 LLM judge（README §6.1）。
 * 本文件是纯契约 + 纯函数，无 IO、无时间副作用。
 */

import type { PermissionLevel } from './authz/permissions.js';

/** 自变量类型（闭集）。 */
export type ExperimentVariableKind = 'feature' | 'skill' | 'model' | 'permission' | 'reasoning';

export const EXPERIMENT_VARIABLE_KINDS: readonly ExperimentVariableKind[] = [
    'feature',
    'skill',
    'model',
    'permission',
    'reasoning',
];

export function isExperimentVariableKind(value: unknown): value is ExperimentVariableKind {
    return (
        typeof value === 'string' &&
        (EXPERIMENT_VARIABLE_KINDS as readonly string[]).includes(value)
    );
}

/** 自变量声明：展示「改了什么」，取值由两臂 spec 承载。 */
export interface ExperimentVariable {
    kind: ExperimentVariableKind;
    label: string;
    baseline: unknown;
    treatment: unknown;
}

/** 控制变量：两臂共用的运行参数（实验定义时冻结，运行期不重读全局设置）。 */
export interface ExperimentBaseline {
    modelId?: string;
    skillIds?: readonly string[];
    features?: Record<string, boolean>;
    permissionCeiling?: PermissionLevel;
    reasoningLevel?: string;
}

/** 单臂配置：在 baseline 之上只覆盖该臂声明的 delta。 */
export interface ExperimentArmSpec {
    /** 'A'（基线）| 'B'（处理）。 */
    label: string;
    modelId?: string;
    /** 该臂独占的技能集合（不给则沿用 baseline.skillIds）。 */
    skills?: readonly string[];
    /** 该臂的 Feature 开关取值。 */
    features?: Record<string, boolean>;
    permissionCeiling?: PermissionLevel;
    reasoningLevel?: string;
}

export type ExperimentArmStatus = 'pending' | 'running' | 'completed' | 'failed' | 'aborted';

export type ExperimentStatus = 'created' | 'running' | 'completed' | 'failed' | 'aborted';

/** 单臂指标（全部来自既有 Goal/Task/Step 与 Usage 事实，不新增真相源）。 */
export interface ExperimentMetrics {
    ok: boolean;
    status: 'succeeded' | 'failed' | 'aborted';
    tasks: number;
    steps: number;
    /** invocation step 数。 */
    toolCalls: number;
    /** deliberation step 数（模型轮次）。 */
    modelRounds: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    costUsd: number;
    durationMs: number;
    ttftMs: number;
    finalAnswer: string;
    finalAnswerChars: number;
    /** 实际观测到的模型（去重、升序）。 */
    models: string[];
    /** 本次运行带入的技能 id。 */
    skills: string[];
    /** 本次运行的有效 Feature 开关。 */
    features: Record<string, boolean>;
}

/** 单臂状态（含 Trace 指针 rootGoalId）。 */
export interface ExperimentArmState {
    label: string;
    spec: ExperimentArmSpec;
    rootGoalId?: string;
    status: ExperimentArmStatus;
    startedAt?: number;
    endedAt?: number;
    metrics?: ExperimentMetrics;
    error?: string;
}

export type ExperimentVerdict = 'A' | 'B' | 'tie' | 'inconclusive';

/** 复盘备注（append-only）。 */
export interface ExperimentReview {
    note: string;
    verdict: ExperimentVerdict;
    at: number;
}

/** 单项指标对比；better = 'none' 表示只展示不判优劣。 */
export interface ComparisonMetric {
    key: string;
    label: string;
    unit: string;
    a: number | boolean;
    b: number | boolean;
    /** b − a（数值指标）。 */
    delta?: number;
    /** delta / a × 100（a = 0 或缺省）。 */
    deltaPct?: number;
    better: 'A' | 'B' | 'tie' | 'none';
}

export interface ExperimentComparison {
    metrics: ComparisonMetric[];
    outputs: { a: string; b: string; identical: boolean };
    /** 执行方式事实：本期两臂顺序执行（共享配额与进程锁）。 */
    execution: 'sequential';
    note: string;
}

interface MetricSpec {
    key: keyof ExperimentMetrics;
    label: string;
    unit: string;
    lowerIsBetter: boolean;
    /** display = 仅展示，不判优劣。 */
    mode: 'better' | 'display';
}

const METRIC_SPECS: readonly MetricSpec[] = [
    { key: 'ok', label: '结局', unit: '', lowerIsBetter: false, mode: 'better' },
    { key: 'costUsd', label: '成本', unit: 'USD', lowerIsBetter: true, mode: 'better' },
    { key: 'inputTokens', label: '输入 token', unit: 'tok', lowerIsBetter: true, mode: 'better' },
    { key: 'outputTokens', label: '输出 token', unit: 'tok', lowerIsBetter: true, mode: 'better' },
    {
        key: 'cachedInputTokens',
        label: '缓存命中 token',
        unit: 'tok',
        lowerIsBetter: true,
        mode: 'better',
    },
    { key: 'steps', label: 'Step 数', unit: '', lowerIsBetter: true, mode: 'better' },
    { key: 'toolCalls', label: '工具调用', unit: '', lowerIsBetter: true, mode: 'better' },
    { key: 'modelRounds', label: '模型轮次', unit: '', lowerIsBetter: true, mode: 'better' },
    { key: 'durationMs', label: '总耗时', unit: 'ms', lowerIsBetter: true, mode: 'better' },
    { key: 'ttftMs', label: '首 token 延迟', unit: 'ms', lowerIsBetter: true, mode: 'better' },
    {
        key: 'finalAnswerChars',
        label: '最终输出长度',
        unit: '字符',
        lowerIsBetter: true,
        mode: 'display',
    },
];

function compareMetric(spec: MetricSpec, a: unknown, b: unknown): ComparisonMetric {
    const base: ComparisonMetric = {
        key: spec.key,
        label: spec.label,
        unit: spec.unit,
        a: a as number | boolean,
        b: b as number | boolean,
        better: 'none',
    };
    if (spec.mode === 'display') return base;
    if (typeof a === 'boolean' || typeof b === 'boolean') {
        const left = a === true;
        const right = b === true;
        base.better = left === right ? 'tie' : left ? 'A' : 'B';
        return base;
    }
    const left = Number(a ?? 0);
    const right = Number(b ?? 0);
    base.delta = right - left;
    if (left !== 0) base.deltaPct = (base.delta / left) * 100;
    if (left === right) {
        base.better = 'tie';
        return base;
    }
    const bWins = spec.lowerIsBetter ? right < left : right > left;
    base.better = bWins ? 'B' : 'A';
    return base;
}

/**
 * 两臂确定性对比：数值差 / 百分比 / 优者。
 *
 * 输出文本不做语义评分（不引入 LLM judge）：只给出原文与 "是否逐字符相同"，
 * 行级 diff 由展示层（@mazi/libs text-diff）从同一原文重算。
 */
export function compareArms(a: ExperimentMetrics, b: ExperimentMetrics): ExperimentComparison {
    return {
        metrics: METRIC_SPECS.map((spec) => compareMetric(spec, a[spec.key], b[spec.key])),
        outputs: { a: a.finalAnswer, b: b.finalAnswer, identical: a.finalAnswer === b.finalAnswer },
        execution: 'sequential',
        note: '确定性指标对比；两臂顺序执行（非并发），耗时仅作参考。',
    };
}
