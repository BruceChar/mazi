import { describe, expect, it } from 'vitest';
import type { ContextSections } from './context-meter';
import { ContextMeter } from './context-meter';
import { TokenEstimator, TokenizerRegistry } from './tokenizer-registry';

/** 测试夹具：只覆盖给定分段，其余分段为空串 */
function sections(partial: Partial<ContextSections> = {}): ContextSections {
    return {
        systemPrompt: '',
        history: '',
        toolSchema: '',
        newInput: '',
        observation: '',
        ...partial,
    };
}

describe('usage ContextMeter 计量（MVP v1.0 §5.2 / §8 F6）', () => {
    it('各分段按默认 char/4 计数，产出 ratio / utilization / delta', () => {
        const breakdown = new ContextMeter().measure(
            sections({
                systemPrompt: 'sys!', // 4 → 1
                history: 'hhhhhhhh', // 8 → 2
                toolSchema: 'tool', // 4 → 1
                newInput: 'new?', // 4 → 1
                observation: 'obs', // 3 → 1
            }),
            12,
            2,
        );
        expect(breakdown.totalContextTokens).toBe(6);
        expect(breakdown.systemPromptTokens).toBe(1);
        expect(breakdown.systemPromptRatio).toBeCloseTo(1 / 6);
        expect(breakdown.contextWindowUtilization).toBeCloseTo(0.5);
        expect(breakdown.contextDeltaFromPrev).toBe(4); // 6 − prev(2)
        expect(breakdown.strategyApplied).toEqual([]); // MVP 不执行压缩
        expect(breakdown.retrievedTokens).toBe(0);
        expect(breakdown.exampleTokens).toBe(0);
    });

    it('可选段 retrieved / examples 计入总量', () => {
        const breakdown = new ContextMeter().measure(
            sections({ retrieved: 'abcdefgh', examples: 'i' }), // 8→2, 1→1
            1000,
        );
        expect(breakdown.retrievedTokens).toBe(2);
        expect(breakdown.exampleTokens).toBe(1);
        expect(breakdown.totalContextTokens).toBe(3);
        expect(breakdown.systemPromptRatio).toBe(0); // systemPrompt 为 0
    });

    it('空输入边界：全 0、ratio 0、utilization 0、delta 对 prev 为负', () => {
        const breakdown = new ContextMeter().measure(sections(), 1000, 5);
        expect(breakdown.totalContextTokens).toBe(0);
        expect(breakdown.systemPromptRatio).toBe(0);
        expect(breakdown.contextWindowUtilization).toBe(0);
        expect(breakdown.contextDeltaFromPrev).toBe(-5);
    });

    it('超窗边界：utilization 封顶 1；恰好等于窗口也为 1', () => {
        const meter = new ContextMeter();
        const over = meter.measure(sections({ systemPrompt: 'a'.repeat(4000) }), 100, 0); // 1000 token
        expect(over.totalContextTokens).toBe(1000);
        expect(over.contextWindowUtilization).toBe(1);
        const exact = meter.measure(sections({ systemPrompt: 'a'.repeat(400) }), 100, 0); // 恰 100
        expect(exact.contextWindowUtilization).toBe(1);
    });

    it('可注入自定义 registry（含自定义默认估算器）', () => {
        const registry = new TokenizerRegistry(new TokenEstimator(2));
        const breakdown = new ContextMeter(registry).measure(
            sections({ systemPrompt: 'abcdef' }), // 2 chars/token → 3
            6,
        );
        expect(breakdown.totalContextTokens).toBe(3);
        expect(breakdown.contextWindowUtilization).toBeCloseTo(0.5);
    });
});
