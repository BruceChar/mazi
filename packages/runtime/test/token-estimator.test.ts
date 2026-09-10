import { describe, expect, it } from 'vitest';
import {
    configureTokenizer,
    estimateTokens,
    estimateTokensWith,
} from '../src/token-estimator.js';

describe('token-estimator（真实 tokenizer）', () => {
    it('空串 → 0', () => {
        expect(estimateTokens('')).toBe(0);
        expect(estimateTokensWith('', 'cl100k_base')).toBe(0);
    });

    it('中文按 tokenizer 计数，明显高于 chars/4 的天真估算', () => {
        const text = '你好世界';
        const naive = Math.ceil(text.length / 4);
        expect(estimateTokensWith(text, 'o200k_base')).toBeGreaterThan(naive);
        expect(estimateTokensWith(text, 'cl100k_base')).toBeGreaterThan(naive);
    });

    it('英文按 tokenizer 计数（hello world = 2）', () => {
        expect(estimateTokensWith('hello world', 'cl100k_base')).toBe(2);
    });

    it('相同文本重复估算稳定，两次编码器共用缓存', () => {
        const a = estimateTokens('请分析这段代码');
        const b = estimateTokens('请分析这段代码');
        expect(a).toBe(b);
        expect(a).toBeGreaterThan(0);
    });

    it('configureTokenizer 接受已知编码；未知值回落默认而不抛错', () => {
        configureTokenizer('cl100k_base');
        expect(estimateTokens('hello world')).toBe(2);
        configureTokenizer('does-not-exist');
        expect(estimateTokens('hello world')).toBeGreaterThan(0);
        configureTokenizer('o200k_base');
    });
});
