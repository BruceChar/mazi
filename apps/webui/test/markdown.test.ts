import { describe, expect, it } from 'vitest';

import {
    detectRawCode,
    escapeHtml,
    markdownForRender,
    renderMarkdown,
} from '../src/scripts/markdown.ts';

// Representative bare Rust source (no Markdown fence): the exact shape that
// rendered split across prose + indented code before the fix. The doc comments
// contain nested triple backticks, which must not be treated as a real fence.
const RAW_RUST = [
    '//! 素数筛法（Sieve of Eratosthenes）。',
    '//!',
    '//! 示例：',
    '/// ```ignore',
    '/// let is_prime = sieve(10);',
    '/// assert!(is_prime[7]);',
    '/// ```',
    'pub fn sieve(limit: usize) -> Vec<bool> {',
    '    let mut is_prime = vec![true; limit + 1];',
    '    is_prime[0] = false;',
    '',
    '    let mut p = 2;',
    '    while p <= limit / p {',
    '        if is_prime[p] {',
    '            let mut multiple = p * p;',
    '            while multiple <= limit {',
    '                is_prime[multiple] = false;',
    '                multiple += p;',
    '            }',
    '        }',
    '        p += 1;',
    '    }',
    '',
    '    is_prime',
    '}',
].join('\n');

const PROSE = [
    '你好，我是助手。',
    '',
    '这个项目当前状态不错，测试全部通过。',
    '需要我继续分析别的模块吗？',
].join('\n');

const MARKDOWN_WITH_STRUCTURE = [
    '## 本轮结论',
    '',
    '- 第一项：测试通过',
    '- 第二项：类型检查通过',
    '',
    '> 引用一段说明。',
    '',
    '| 指标 | 值 |',
    '| --- | --- |',
    '| tests | 201 |',
].join('\n');

const FENCED = [
    '下面是实现：',
    '',
    '```rust',
    'fn main() {',
    '    println!("hi");',
    '}',
    '```',
].join('\n');

describe('markdown raw-code detection', () => {
    it('detects a bare Rust source answer as raw code', () => {
        expect(detectRawCode(RAW_RUST)).toBe(true);
    });

    it('ignores nested triple backticks inside line comments', () => {
        // The sample has `/// ```ignore` doc comments; only a fence at the
        // start of a line counts, so the whole answer is still raw code.
        expect(RAW_RUST).toContain('/// ```ignore');
        expect(detectRawCode(RAW_RUST)).toBe(true);
    });

    it('does not treat prose as raw code', () => {
        expect(detectRawCode(PROSE)).toBe(false);
    });

    it('does not treat Markdown block structure as raw code', () => {
        expect(detectRawCode(MARKDOWN_WITH_STRUCTURE)).toBe(false);
    });

    it('does not treat already fenced Markdown as raw code', () => {
        expect(detectRawCode(FENCED)).toBe(false);
    });

    it('does not treat prose with inline code as raw code', () => {
        expect(detectRawCode('使用 `pnpm test` 运行测试，然后看结果。')).toBe(false);
    });

    it('does not treat Markdown emphasis lines as raw code', () => {
        // Real false positive: both lines start with ** (bold), which used to be
        // classified as a C block-comment continuation.
        const emphasized = [
            '**红灯确认** ✅（`cargo test` 编译失败，5 处符号找不到）。',
            '',
            '**第二步：实现 3 路快排**——新建 `src/quicksort3.rs` 并声明模块。',
        ].join('\n');
        expect(detectRawCode(emphasized)).toBe(false);
    });

    it('handles empty and whitespace-only text', () => {
        expect(detectRawCode('')).toBe(false);
        expect(detectRawCode('   \n\n  ')).toBe(false);
    });
});

describe('markdownForRender', () => {
    it('wraps raw code in one escaped pre/code block', () => {
        const html = markdownForRender(RAW_RUST);
        expect(html).not.toBeNull();
        expect(html?.startsWith('<pre><code>')).toBe(true);
        expect(html?.endsWith('</code></pre>')).toBe(true);
        // Exactly one block: no second fence split by marked.
        expect(html?.match(/<pre>/g)?.length).toBe(1);
    });

    it('escapes HTML special characters in raw code', () => {
        const code = [
            'const html = "<script>alert(1)</script>";',
            'const amp = "a & b";',
            'if (html) {',
            '    console.log(amp);',
            '}',
        ].join('\n');
        const html = markdownForRender(code);
        expect(html).toContain('&lt;script&gt;');
        expect(html).toContain('&amp;');
        expect(html).not.toContain('<script>');
    });

    it('defers non-code text to the Markdown renderer (null)', () => {
        expect(markdownForRender(PROSE)).toBeNull();
        expect(markdownForRender(MARKDOWN_WITH_STRUCTURE)).toBeNull();
        expect(markdownForRender('')).toBeNull();
    });
});

describe('escapeHtml', () => {
    it('escapes &, < and > only (quotes stay readable)', () => {
        expect(escapeHtml('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d "e"');
    });
});

describe('renderMarkdown', () => {
    it('renders bare code as one escaped block without touching the DOM', () => {
        const html = renderMarkdown(RAW_RUST);
        expect(html.startsWith('<pre><code>')).toBe(true);
        expect(html.match(/<pre>/g)?.length).toBe(1);
    });

    it('returns an empty string for empty input', () => {
        expect(renderMarkdown('')).toBe('');
    });
});
