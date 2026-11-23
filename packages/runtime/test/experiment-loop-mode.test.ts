import { describe, expect, it } from 'vitest';
import { collectMetrics } from '../src/experiment/metrics.js';
import { ExperimentSpecError, validateExperimentSpec } from '../src/experiment/spec.js';

describe('实验自变量 loopMode', () => {
    const baseSpec = {
        title: 'loop 对照',
        input: '同一输入',
        variables: [
            { kind: 'loopMode', baseline: 'default', treatment: 'dynamic' },
        ],
        arms: [{ label: 'A' }, { label: 'B', loopMode: 'dynamic' }],
    };

    it('接受 default/dynamic 并冻结进 spec', () => {
        const spec = validateExperimentSpec({ ...baseSpec, baseline: { loopMode: 'default' } });
        expect(spec.baseline.loopMode).toBe('default');
        expect(spec.arms[1]?.loopMode).toBe('dynamic');
        expect(spec.variables[0]?.kind).toBe('loopMode');
    });

    it('拒绝闭集外的 loopMode', () => {
        expect(() =>
            validateExperimentSpec({ ...baseSpec, arms: [{ label: 'A' }, { label: 'B', loopMode: 'x' }] }),
        ).toThrow(ExperimentSpecError);
    });

    it('指标记录 loop 模式、终止原因与节点数', () => {
        const metrics = collectMetrics({
            snapshot: { goals: [], taskCount: 0 } as never,
            ok: true,
            startedAt: 10,
            endedAt: 20,
            skills: [],
            features: {},
            loop: {
                mode: 'dynamic',
                termination: 'done-unverified',
                nodeCount: 7,
                nodeTrail: [
                    { kind: 'selected', role: 'think', nodeId: 'think', at: 11 },
                    { kind: 'selected', role: 'act', nodeId: 'act', at: 12 },
                    { kind: 'terminated', reason: 'done-unverified', at: 13 },
                ],
            },
        });
        expect(metrics.loopMode).toBe('dynamic');
        expect(metrics.termination).toBe('done-unverified');
        expect(metrics.nodeCount).toBe(7);
        expect(metrics.loopNodes?.map((node) => node.role)).toEqual(['think', 'act', undefined]);
    });

    it('未传 loop 时按 default 记录，termination 回落 reason', () => {
        const metrics = collectMetrics({
            snapshot: { goals: [], taskCount: 0 } as never,
            ok: false,
            reason: 'aborted',
            startedAt: 10,
            endedAt: 20,
            skills: [],
            features: {},
        });
        expect(metrics.loopMode).toBe('default');
        expect(metrics.termination).toBe('aborted');
        expect(metrics.nodeCount).toBeUndefined();
    });
});
