import { describe, expect, it } from 'vitest';
import {
    entryCountLabel,
    recentEntries,
    snapshotSections,
    wikiEmptyText,
    wikiUpdatedLabel,
} from '../src/scripts/wiki.ts';

describe('wiki 视图纯函数（docs/项目wiki设计.md §11）', () => {
    it('snapshotSections 按二级标题切分快照', () => {
        const sections = snapshotSections('## 项目概览\n定位\n\n## 进行中的工作\n- 做 A');
        expect(sections.map((section) => section.title)).toEqual(['项目概览', '进行中的工作']);
        expect(sections[0].body).toBe('定位');
        expect(snapshotSections(null)).toEqual([]);
        expect(snapshotSections('没有标题的文本')).toEqual([]);
    });

    it('recentEntries 取尾部 N 条并保持升序', () => {
        const entries = Array.from({ length: 5 }, (_, index) => ({
            ts: '2026-10-1' + index,
            change: 'c' + index,
        }));
        expect(recentEntries(entries, 2).map((entry) => entry.change)).toEqual(['c3', 'c4']);
        expect(recentEntries(entries)).toHaveLength(5);
        expect(recentEntries(undefined)).toEqual([]);
    });

    it('entryCountLabel / wikiUpdatedLabel / wikiEmptyText', () => {
        expect(entryCountLabel(0)).toBe('暂无变更');
        expect(entryCountLabel(3)).toBe('3 条变更');
        expect(wikiUpdatedLabel(undefined)).toBe('尚未生成');
        expect(wikiUpdatedLabel('2026-10-16T02:13:40+08:00')).toBe('2026-10-16 02:13:40 +08:00');
        expect(wikiEmptyText('  ')).toContain('请先选择工作区');
        expect(wikiEmptyText('/tmp/x')).toContain('会自动记录');
    });
});
