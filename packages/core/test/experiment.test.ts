import { describe, expect, it } from 'vitest';
import type { ExperimentMetrics } from '../src/experiment.js';
import {
    compareArms,
    EXPERIMENT_VARIABLE_KINDS,
    isExperimentVariableKind,
} from '../src/experiment.js';

function metrics(partial: Partial<ExperimentMetrics> = {}): ExperimentMetrics {
    return {
        ok: true,
        status: 'succeeded',
        tasks: 1,
        steps: 4,
        toolCalls: 1,
        modelRounds: 2,
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 0,
        costUsd: 0.01,
        durationMs: 1000,
        ttftMs: 100,
        finalAnswer: '答案',
        finalAnswerChars: 2,
        models: ['m'],
        skills: [],
        features: {},
        ...partial,
    };
}

describe('Experiment 自变量闭集', () => {
    it('只承认声明的 kind', () => {
        expect(EXPERIMENT_VARIABLE_KINDS).toContain('feature');
        expect(isExperimentVariableKind('model')).toBe(true);
        expect(isExperimentVariableKind('bucket')).toBe(false);
        expect(isExperimentVariableKind(1)).toBe(false);
    });
});

describe('compareArms（确定性对比）', () => {
    it('低更优指标：B 更省 → B 胜；delta = B − A，deltaPct 归一到 A', () => {
        const comparison = compareArms(
            metrics({ costUsd: 0.02, inputTokens: 200 }),
            metrics({ costUsd: 0.01, inputTokens: 100 }),
        );
        const cost = comparison.metrics.find((m) => m.key === 'costUsd');
        expect(cost?.better).toBe('B');
        expect(cost?.delta).toBeCloseTo(-0.01, 12);
        expect(cost?.deltaPct).toBeCloseTo(-50, 10);
        const input = comparison.metrics.find((m) => m.key === 'inputTokens');
        expect(input?.better).toBe('B');
    });

    it('A 更优时标 A（不总是「B 胜」）', () => {
        const comparison = compareArms(
            metrics({ durationMs: 500 }),
            metrics({ durationMs: 900 }),
        );
        expect(comparison.metrics.find((m) => m.key === 'durationMs')?.better).toBe('A');
    });

    it('相等 → tie，delta = 0', () => {
        const comparison = compareArms(metrics(), metrics());
        const steps = comparison.metrics.find((m) => m.key === 'steps');
        expect(steps?.better).toBe('tie');
        expect(steps?.delta).toBe(0);
    });

    it('结局是布尔：成功优于失败', () => {
        const comparison = compareArms(
            metrics({ ok: true, status: 'succeeded' }),
            metrics({ ok: false, status: 'failed' }),
        );
        expect(comparison.metrics.find((m) => m.key === 'ok')?.better).toBe('A');
    });

    it('输出长度只展示不判优劣；输出相同 → identical', () => {
        const comparison = compareArms(
            metrics({ finalAnswer: '同样', finalAnswerChars: 2 }),
            metrics({ finalAnswer: '同样', finalAnswerChars: 2 }),
        );
        expect(comparison.metrics.find((m) => m.key === 'finalAnswerChars')?.better).toBe('none');
        expect(comparison.outputs.identical).toBe(true);
        expect(comparison.outputs.a).toBe('同样');
    });

    it('输出不同 → identical=false，保留两臂原文', () => {
        const comparison = compareArms(
            metrics({ finalAnswer: 'A 的答案' }),
            metrics({ finalAnswer: 'B 的答案' }),
        );
        expect(comparison.outputs.identical).toBe(false);
        expect(comparison.outputs.b).toBe('B 的答案');
        expect(comparison.execution).toBe('sequential');
    });
});
