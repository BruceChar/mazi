import { describe, expect, it } from 'vitest';
import { compactWikiSummary, WIKI_SUMMARY_LIMIT } from '../src/wiki-summary.js';

describe('compactWikiSummary（项目 Wiki 人读摘要）', () => {
    it('完全丢弃 fenced 代码块（Agent 常以 checkpoint 代码块收尾）', () => {
        const fenced = ['```', 'wiki(checkpoint): ok', 'docs_changed:', '- INDEX.md', '```'].join(
            '\n',
        );
        expect(compactWikiSummary(fenced)).toBe('');
    });

    it('保留代码块外的正文，丢弃块内内容', () => {
        const mixed = [
            '已更新 3 个文档。',
            '```text',
            'wiki(checkpoint): ok',
            '```',
            '旧事实已核验。',
        ].join('\n');
        expect(compactWikiSummary(mixed)).toBe('已更新 3 个文档。 旧事实已核验。');
    });

    it('去掉 Markdown 标记、行内反引号与 HTML 注释', () => {
        const text = [
            '<!-- activity:start -->',
            '## 更新完成',
            '- 使用 `pnpm test` 验证',
            '> 事实已核验',
            '<!-- activity:end -->',
        ].join('\n');
        expect(compactWikiSummary(text)).toBe('更新完成 使用 pnpm test 验证 事实已核验');
    });

    it('折叠空白并压缩单行', () => {
        expect(compactWikiSummary('  a  \n\n b\t c ')).toBe('a b c');
    });

    it('超长时按上限截断并加省略号', () => {
        const long = 'x'.repeat(WIKI_SUMMARY_LIMIT + 50);
        const compacted = compactWikiSummary(long);
        expect(compacted.endsWith('…')).toBe(true);
        expect(Array.from(compacted)).toHaveLength(WIKI_SUMMARY_LIMIT);
        expect(compactWikiSummary(long, 10)).toBe('xxxxxxxxx…');
    });

    it('只含空白 / 代码 / 注释 → 空串', () => {
        expect(compactWikiSummary('')).toBe('');
        expect(compactWikiSummary('   \n\n')).toBe('');
        expect(compactWikiSummary('<!-- only comment -->')).toBe('');
        expect(compactWikiSummary('```\nonly code\n```')).toBe('');
    });

    it('无字段缺失时不抛错（防御上游 undefined）', () => {
        expect(compactWikiSummary(undefined as unknown as string)).toBe('');
        expect(compactWikiSummary(null as unknown as string)).toBe('');
    });
});
