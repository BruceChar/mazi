import { describe, expect, it } from 'vitest';
import type {
    ComparisonMetricView,
    ExperimentArmView,
    ExperimentView,
} from '../src/scripts/experiments.ts';
import {
    armConfigSummary,
    armFeatureLabels,
    armStatusLabel,
    betterLabel,
    canCompare,
    comparisonTally,
    experimentStatusLabel,
    formatDelta,
    formatDeltaPct,
    buildExperimentSpec,
    formatMetric,
    traceRounds,
    traceToolRows,
    variableFormula,
    variableValueText,
    verdictLabel,
} from '../src/scripts/experiments.ts';

function metric(partial: Partial<ComparisonMetricView> = {}): ComparisonMetricView {
    return { key: 'costUsd', label: '成本', unit: 'USD', a: 0.02, b: 0.01, better: 'B', ...partial };
}

function arm(partial: Partial<ExperimentArmView> = {}): ExperimentArmView {
    return { label: 'A', spec: { label: 'A' }, status: 'completed', ...partial };
}

function view(partial: Partial<ExperimentView> = {}): ExperimentView {
    return {
        experimentId: 'x',
        title: 't',
        input: 'i',
        baseline: {},
        variables: [],
        arms: [arm(), arm({ label: 'B' })],
        status: 'completed',
        createdAt: 0,
        reviews: [],
        ...partial,
    };
}

describe('实验台展示投影', () => {
    it('自变量取值：字符串/数字/布尔/数组/对象/空值', () => {
        expect(variableValueText('m1')).toBe('m1');
        expect(variableValueText(3)).toBe('3');
        expect(variableValueText(true)).toBe('true');
        expect(variableValueText(['a', 'b'])).toBe('a, b');
        expect(variableValueText([])).toBe('（空）');
        expect(variableValueText({ concise: true })).toBe('concise=true');
        expect(variableValueText({})).toBe('（空）');
        expect(variableValueText(null)).toBe('—');
    });

    it('自变量公式：kind · 基线 → 处理', () => {
        expect(
            variableFormula({ kind: 'model', label: '模型', baseline: 'm1', treatment: 'm2' }),
        ).toBe('model · m1 → m2');
    });

    it('数值格式化：USD / ms / tok / 计数 / 布尔', () => {
        expect(formatMetric(0.0123456, 'USD')).toBe('$0.012346');
        expect(formatMetric(450, 'ms')).toBe('450ms');
        expect(formatMetric(1500, 'ms')).toBe('1.50s');
        expect(formatMetric(12345, 'tok')).toBe('12,345');
        expect(formatMetric(7, '')).toBe('7');
        expect(formatMetric(true, '')).toBe('成功');
        expect(formatMetric(false, '')).toBe('失败');
    });

    it('Δ 与 Δ%：带符号；缺 delta 显示 —', () => {
        expect(formatDelta(metric({ delta: -0.01 }))).toBe('−0.010000');
        expect(formatDelta(metric({ delta: 250, unit: 'ms' }))).toBe('+250');
        expect(formatDelta(metric({ delta: 3, unit: '' }))).toBe('+3');
        expect(formatDelta(metric({ delta: undefined }))).toBe('—');
        expect(formatDeltaPct(metric({ deltaPct: -50 }))).toBe('-50.0%');
        expect(formatDeltaPct(metric({ deltaPct: undefined }))).toBe('—');
    });

    it('结论计数与标签', () => {
        const comparison = {
            metrics: [
                metric({ better: 'B' }),
                metric({ key: 'steps', better: 'A' }),
                metric({ key: 'ttftMs', better: 'tie' }),
                metric({ key: 'finalAnswerChars', better: 'none' }),
            ],
            outputs: { a: '', b: '', identical: false },
            execution: 'sequential',
            note: '',
        };
        expect(comparisonTally(comparison)).toEqual({ a: 1, b: 1, tie: 1 });
        expect(comparisonTally(undefined)).toEqual({ a: 0, b: 0, tie: 0 });
        expect(betterLabel('B')).toBe('B');
        expect(betterLabel('none')).toBe('—');
        expect(verdictLabel('inconclusive')).toBe('不确定');
        expect(armStatusLabel('completed')).toBe('完成');
        expect(experimentStatusLabel('aborted')).toBe('已中止');
    });

    it('臂摘要：实际开启的 Feature 与配置（含默认回退）', () => {
        const b = arm({
            label: 'B',
            spec: { label: 'B', modelId: 'm2', skills: ['s1'], reasoningLevel: 'low' },
            metrics: {
                ok: true,
                status: 'succeeded',
                tasks: 1,
                steps: 1,
                toolCalls: 0,
                modelRounds: 1,
                inputTokens: 0,
                outputTokens: 0,
                cachedInputTokens: 0,
                costUsd: 0,
                durationMs: 0,
                ttftMs: 0,
                finalAnswer: '',
                finalAnswerChars: 0,
                models: ['m2'],
                skills: ['s1'],
                features: { concise: true, other: false },
            },
        });
        expect(armFeatureLabels(b)).toEqual(['concise']);
        expect(armConfigSummary(b)).toBe('模型 m2 · 技能 s1 · 推理 low');
        expect(armConfigSummary(arm())).toBe('模型 （默认） · 技能 （全局挂载）');
    });

    it('canCompare：需要 comparison 且两臂都有指标', () => {
        expect(canCompare(view())).toBe(false);
        expect(canCompare(view({ comparison: { metrics: [], outputs: { a: '', b: '', identical: true }, execution: 'sequential', note: '' } }))).toBe(false);
    });
});
function form(partial: Partial<import('../src/scripts/experiments.ts').ExperimentFormState> = {}) {
    return {
        title: '对照实验',
        hypothesis: '',
        input: '同一输入',
        workspace: '',
        kind: 'feature' as const,
        modelA: '',
        modelB: '',
        featureId: 'concise',
        skillA: '',
        skillB: '',
        reasoningA: '',
        reasoningB: '',
        permissionA: '',
        permissionB: '',
        ...partial,
    };
}

describe('buildExperimentSpec（表单 → 实验定义）', () => {
    it('feature 自变量：A 关 B 开，变量声明记录两取值', () => {
        const { spec, error } = buildExperimentSpec(form());
        expect(error).toBeUndefined();
        expect(spec?.variables).toEqual([
            { kind: 'feature', label: 'Feature 开关', baseline: false, treatment: true },
        ]);
        expect(spec?.arms).toEqual([
            { label: 'A', features: { concise: false } },
            { label: 'B', features: { concise: true } },
        ]);
        expect(spec?.hypothesis).toBeUndefined();
        expect(spec?.workspace).toBeUndefined();
    });

    it('model 自变量：两臂不同模型；可选字段按填写保留', () => {
        const { spec } = buildExperimentSpec(
            form({ kind: 'model', modelA: 'm1', modelB: 'm2', hypothesis: ' m2 更省 ', workspace: '/w' }),
        );
        expect(spec?.arms).toEqual([
            { label: 'A', modelId: 'm1' },
            { label: 'B', modelId: 'm2' },
        ]);
        expect(spec?.variables).toEqual([
            { kind: 'model', label: '模型', baseline: 'm1', treatment: 'm2' },
        ]);
        expect(spec?.hypothesis).toBe('m2 更省');
        expect(spec?.workspace).toBe('/w');
    });

    it('skill 自变量：逗号/换行分隔并去重；两臂可为空集合', () => {
        const { spec } = buildExperimentSpec(
            form({ kind: 'skill', skillA: 'a, b\nb', skillB: '' }),
        );
        expect(spec?.arms).toEqual([
            { label: 'A', skills: ['a', 'b'] },
            { label: 'B', skills: [] },
        ]);
    });

    it('必填校验：标题 / 输入 / 两臂取值', () => {
        expect(buildExperimentSpec(form({ title: ' ' })).error).toBe('请填写实验标题');
        expect(buildExperimentSpec(form({ input: '' })).error).toBe('请填写两臂共用的输入');
        expect(buildExperimentSpec(form({ featureId: '' })).error).toBe('请选择要对照的 Feature');
        expect(buildExperimentSpec(form({ kind: 'model', modelA: 'm1' })).error).toBe('请选择两臂模型');
        expect(
            buildExperimentSpec(form({ kind: 'skill', skillA: '', skillB: '' })).error,
        ).toBe('至少给一臂一个 Skill');
        expect(
            buildExperimentSpec(form({ kind: 'reasoning', reasoningA: 'low' })).error,
        ).toBe('请选择两臂推理强度');
        expect(
            buildExperimentSpec(form({ kind: 'permission', permissionA: 'read-only' })).error,
        ).toBe('请选择两臂权限档位');
    });

    it('reasoning / permission 自变量写入对应臂字段', () => {
        const reasoning = buildExperimentSpec(
            form({ kind: 'reasoning', reasoningA: 'low', reasoningB: 'high' }),
        );
        expect(reasoning.spec?.arms).toEqual([
            { label: 'A', reasoningLevel: 'low' },
            { label: 'B', reasoningLevel: 'high' },
        ]);
        const permission = buildExperimentSpec(
            form({ kind: 'permission', permissionA: 'read-only', permissionB: 'draft' }),
        );
        expect(permission.spec?.arms).toEqual([
            { label: 'A', permissionCeiling: 'read-only' },
            { label: 'B', permissionCeiling: 'draft' },
        ]);
    });
});

describe('Trace 投影（两臂并排）', () => {
    const snapshot = {
        rootGoalId: 'r',
        taskCount: 1,
        stepCount: 3,
        goals: [
            {
                goalId: 'g',
                status: 'succeeded',
                statement: 's',
                tasks: [
                    {
                        taskId: 't',
                        status: 'succeeded',
                        title: 'T',
                        steps: [
                            {
                                stepId: 's1',
                                kind: 'deliberation',
                                status: 'succeeded',
                                startedAt: 100,
                                endedAt: 300,
                                answer: '第一轮',
                                usage: { roundId: 'r1', raw: { modelId: 'm1', inputTokens: 10, outputTokens: 5 }, cost: { totalCostUsd: 0.001 } },
                            },
                            {
                                stepId: 's2',
                                kind: 'invocation',
                                status: 'succeeded',
                                startedAt: 310,
                                toolName: 'fs.read',
                                toolCwd: '/w',
                                toolOutput: 'ok\n  done',
                            },
                            {
                                stepId: 's3',
                                kind: 'deliberation',
                                status: 'succeeded',
                                startedAt: 400,
                                endedAt: 500,
                                answer: '最终答案',
                                usage: { roundId: 'r2', raw: { modelId: 'm1', inputTokens: 20, outputTokens: 7 }, cost: { totalCostUsd: 0.002 } },
                            },
                        ],
                    },
                ],
            },
        ],
    };
    it('轮次表：按 roundId 去重、耗时与 token 归位', () => {
        const rows = traceRounds(snapshot as never);
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({ index: 1, model: 'm1', inputTokens: 10, durationMs: 200 });
        expect(rows[1]).toMatchObject({ index: 2, inputTokens: 20, durationMs: 100 });
        expect(traceRounds(null)).toEqual([]);
    });
    it('工具表：只取 invocation，空白折叠', () => {
        expect(traceToolRows(snapshot as never)).toEqual([
            { toolName: 'fs.read', cwd: '/w', output: 'ok done' },
        ]);
        expect(traceToolRows(undefined)).toEqual([]);
    });
});
