import { describe, expect, it } from 'vitest';
import type { FeatureDefinition } from '../src/features.js';
import { isValidFeatureId, resolveFeatures } from '../src/features.js';

function feature(partial: Partial<FeatureDefinition> & { id: string }): FeatureDefinition {
    return {
        name: partial.id,
        description: '特性 ' + partial.id,
        enabled: false,
        ...partial,
    };
}

describe('Feature 解析（docs/AB测试设计.md §3.2）', () => {
    it('按默认值求值，trace 标注 default 来源；override 覆盖并标注 override', () => {
        const definitions = [feature({ id: 'alpha', enabled: true }), feature({ id: 'beta' })];
        const resolved = resolveFeatures(definitions, { beta: true });
        expect(resolved.values).toEqual({ alpha: true, beta: true });
        expect(resolved.enabledIds).toEqual(['alpha', 'beta']);
        expect(resolved.trace).toEqual([
            { id: 'alpha', enabled: true, source: 'default' },
            { id: 'beta', enabled: true, source: 'override' },
        ]);
    });

    it('未知 id 的 override 不参与求值（没有定义就没有值）', () => {
        const resolved = resolveFeatures([feature({ id: 'alpha', enabled: true })], {
            ghost: true,
        });
        expect(resolved.values).toEqual({ alpha: true });
        expect(resolved.enabledIds).toEqual(['alpha']);
    });

    it('与 definitions 传入顺序无关（按 id 升序求值，可复现）', () => {
        const a = feature({ id: 'zeta', enabled: true, promptFragment: 'Z' });
        const b = feature({ id: 'alpha', enabled: true, promptFragment: 'A' });
        const forward = resolveFeatures([a, b]);
        const backward = resolveFeatures([b, a]);
        expect(forward.promptFragment).toBe('A\n\nZ');
        expect(backward.promptFragment).toBe(forward.promptFragment);
        expect(backward.enabledIds).toEqual(['alpha', 'zeta']);
    });

    it('promptFragment 只在开启时拼接，空片段被忽略', () => {
        const resolved = resolveFeatures([
            feature({ id: 'on', enabled: true, promptFragment: '  先读文件  ' }),
            feature({ id: 'off', enabled: false, promptFragment: '不该出现' }),
            feature({ id: 'blank', enabled: true, promptFragment: '   ' }),
        ]);
        expect(resolved.promptFragment).toBe('先读文件');
    });

    it('allowedTools 取所有开启特性的交集（只收窄，不放宽）', () => {
        const resolved = resolveFeatures([
            feature({ id: 'a', enabled: true, allowedTools: ['fs.read', 'shell.run'] }),
            feature({ id: 'b', enabled: true, allowedTools: ['fs.read', 'rg'] }),
            feature({ id: 'c', enabled: false, allowedTools: ['fs.read'] }),
        ]);
        expect(resolved.allowedTools).toEqual(['fs.read']);
    });

    it('无开启特性声明 allowedTools 时，不额外收窄（undefined）', () => {
        const resolved = resolveFeatures([feature({ id: 'a', enabled: true })]);
        expect(resolved.allowedTools).toBeUndefined();
    });

    it('skillMode: only 独占技能集合；add 时并入并集；inherit 时不影响', () => {
        const only = resolveFeatures([
            feature({ id: 'a', enabled: true, skills: ['s1'], skillMode: 'add' }),
            feature({ id: 'b', enabled: true, skills: ['s2'], skillMode: 'only' }),
        ]);
        expect(only.skillMode).toBe('only');
        expect(only.skillIds).toEqual(['s1', 's2']);

        const add = resolveFeatures([feature({ id: 'a', enabled: true, skills: ['s1', 's2'] })]);
        expect(add.skillMode).toBe('add');
        expect(add.skillIds).toEqual(['s1', 's2']);

        const inherit = resolveFeatures([feature({ id: 'a', enabled: true })]);
        expect(inherit.skillMode).toBe('inherit');
        expect(inherit.skillIds).toEqual([]);
    });

    it('reasoningLevel 取按 id 升序的第一个声明', () => {
        const resolved = resolveFeatures([
            feature({ id: 'zzz', enabled: true, reasoningLevel: 'high' }),
            feature({ id: 'aaa', enabled: true, reasoningLevel: 'low' }),
        ]);
        expect(resolved.reasoningLevel).toBe('low');
    });

    it('纯函数：同输入同输出，且不修改入参', () => {
        const definitions = [feature({ id: 'a', enabled: true, skills: ['s'] })];
        const snapshot = JSON.stringify(definitions);
        const first = resolveFeatures(definitions, { a: false });
        const second = resolveFeatures(definitions, { a: false });
        expect(first).toEqual(second);
        expect(JSON.stringify(definitions)).toBe(snapshot);
    });
});

describe('Feature id 规范', () => {
    it('只接受 kebab-case', () => {
        expect(isValidFeatureId('concise-answers')).toBe(true);
        expect(isValidFeatureId('v2-plan')).toBe(true);
        expect(isValidFeatureId('Concise')).toBe(false);
        expect(isValidFeatureId('a_b')).toBe(false);
        expect(isValidFeatureId('-lead')).toBe(false);
        expect(isValidFeatureId('')).toBe(false);
    });
});
