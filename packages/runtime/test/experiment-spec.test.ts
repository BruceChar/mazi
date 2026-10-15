import { describe, expect, it } from 'vitest';
import { validateExperimentSpec, ExperimentSpecError } from '../src/experiment/spec.js';

function base(): Record<string, unknown> {
    return {
        title: '对照',
        input: '同一输入',
        variables: [{ kind: 'model', label: '模型', baseline: 'm1', treatment: 'm2' }],
        arms: [{ label: 'A', modelId: 'm1' }, { label: 'B', modelId: 'm2' }],
    };
}

describe('validateExperimentSpec', () => {
    it('合法输入 → 归一 spec（缺省 baseline = {}，可选字段保留）', () => {
        const spec = validateExperimentSpec({ ...base(), hypothesis: ' m2 更省 ', workspace: '/w' });
        expect(spec.baseline).toEqual({});
        expect(spec.hypothesis).toBe('m2 更省');
        expect(spec.workspace).toBe('/w');
        expect(spec.arms.map((arm) => arm.label)).toEqual(['A', 'B']);
    });

    it('title/input 必填', () => {
        expect(() => validateExperimentSpec({ ...base(), title: '  ' })).toThrow(ExperimentSpecError);
        expect(() => validateExperimentSpec({ ...base(), input: '' })).toThrow(ExperimentSpecError);
    });

    it('arms 必须恰好两个且 label 唯一', () => {
        const one = { ...base(), arms: [{ label: 'A' }] };
        expect(() => validateExperimentSpec(one)).toThrow(/恰好两个/);
        const same = { ...base(), arms: [{ label: 'A' }, { label: 'A' }] };
        expect(() => validateExperimentSpec(same)).toThrow(/label/);
        const defaults = { ...base(), arms: [{}, {}] };
        expect(validateExperimentSpec(defaults).arms.map((arm) => arm.label)).toEqual(['A', 'B']);
    });

    it('variables 至少一项且 kind 在闭集内', () => {
        expect(() => validateExperimentSpec({ ...base(), variables: [] })).toThrow(/至少声明一项/);
        expect(() =>
            validateExperimentSpec({
                ...base(),
                variables: [{ kind: 'bucket', label: 'x', baseline: 1, treatment: 2 }],
            }),
        ).toThrow(/闭集/);
    });

    it('归一 skills / features；features 值必须布尔', () => {
        const spec = validateExperimentSpec({
            ...base(),
            baseline: { skillIds: ['b', 'a', 'a'] },
            arms: [{ label: 'A', features: { concise: false } }, { label: 'B', features: { concise: true } }],
        });
        expect(spec.baseline.skillIds).toEqual(['a', 'b']);
        expect(spec.arms[1]?.features).toEqual({ concise: true });
        expect(() =>
            validateExperimentSpec({ ...base(), arms: [{ features: { x: 1 } }, { label: 'B' }] }),
        ).toThrow(/features/);
    });

    it('非对象输入 → 400 语义错误', () => {
        expect(() => validateExperimentSpec(null)).toThrow(/请求体/);
    });
});
