import { describe, expect, it } from 'vitest';
import { TokenEstimator, TokenizerRegistry } from './tokenizer-registry.js';

describe('usage tokenizer 估算与厂商注册（MVP v1.0 §8 F6）', () => {
    it('TokenEstimator 默认 charsPerToken=4 向上取整；空串为 0', () => {
        const estimator = new TokenEstimator();
        expect(estimator.estimate('')).toBe(0);
        expect(estimator.estimate('abcd')).toBe(1); // 恰好 4 字符
        expect(estimator.estimate('abcdefghij')).toBe(3); // 10 字符 → ceil(10/4)
        expect(estimator.estimate('中文字符串')).toBe(2); // 5 字符（按字符非字节）
    });

    it('TokenEstimator 支持自定义 charsPerToken', () => {
        expect(new TokenEstimator(2).estimate('abcdef')).toBe(3);
    });

    it('注册厂商估算器后按其估算；未注册/未指定厂商回退默认', () => {
        const registry = new TokenizerRegistry();
        // 词数估算器：空格分词
        registry.register('openai', { estimate: (text) => text.split(' ').length });
        const text = 'a b c d e';
        expect(registry.estimate(text, 'openai')).toBe(5);
        // 未指定厂商 → 默认 char/4
        expect(registry.estimate(text)).toBe(Math.ceil(text.length / 4));
        // 未注册的厂商名 → 回退默认
        expect(registry.estimate(text, 'unknown-vendor')).toBe(Math.ceil(text.length / 4));
    });

    it('count 按 sections 逐段估算并保留 key；同名厂商可覆盖注册', () => {
        const registry = new TokenizerRegistry();
        expect(registry.count({ systemPrompt: 'abcd', history: 'efghij' })).toEqual({
            systemPrompt: 1,
            history: 2,
        });
        registry.register('anthropic', new TokenEstimator(2));
        expect(registry.count({ systemPrompt: 'abcdef' }, 'anthropic')).toEqual({
            systemPrompt: 3,
        });
    });
});
