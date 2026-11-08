import { describe, expect, it } from 'vitest';
import {
    entryCountLabel,
    recentEntries,
    resolveWikiDocumentPath,
    snapshotSections,
    wikiClaimStatusLabel,
    wikiClaimsAttention,
    wikiDocumentGroupLabel,
    wikiDocumentLabel,
    wikiEmptyText,
    wikiRepositoryEmptyText,
    wikiUpdatedLabel,
    wikiWorkspaceFor,
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

    it('wikiWorkspaceFor：项目路径优先，缺省回退当前会话工作区', () => {
        expect(wikiWorkspaceFor('/Users/bruce/nodejs/whoami/', '/tmp/other')).toBe(
            '/Users/bruce/nodejs/whoami/',
        );
        expect(wikiWorkspaceFor(undefined, '/tmp/other')).toBe('/tmp/other');
        expect(wikiWorkspaceFor('   ', '  ')).toBe('');
    });

    it('v2 文档与 claims 使用面向任意项目的中文标签', () => {
        expect(wikiDocumentLabel({ path: 'overview/conventions.md', title: '约定' })).toBe(
            '工作方式',
        );
        expect(wikiDocumentLabel({ path: 'notes/research.md', title: '研究笔记' })).toBe(
            '研究笔记',
        );
        expect(wikiDocumentGroupLabel('overview')).toBe('项目知识');
        expect(wikiClaimStatusLabel('stale')).toBe('待复核');
        expect(wikiClaimsAttention({ documents: 4, claims: 5, active: 3, stale: 1, missing: 1, retracted: 0 })).toBe(2);
        expect(wikiRepositoryEmptyText(undefined)).toContain('v2 知识库');
        expect(
            wikiRepositoryEmptyText({
                root: '/tmp/project',
                indexPath: '/tmp/project/wiki/INDEX.md',
                index: '',
                docs: [],
                claims: [],
                summary: {
                    documents: 0,
                    claims: 0,
                    active: 0,
                    stale: 0,
                    missing: 0,
                    retracted: 0,
                },
            }),
        ).toContain('还没有文档');
    });

    it('resolveWikiDocumentPath 只解析 wiki 内的相对 Markdown 链接', () => {
        expect(resolveWikiDocumentPath('INDEX.md', 'overview/conventions.md#约定')).toBe(
            'overview/conventions.md',
        );
        expect(resolveWikiDocumentPath('overview/conventions.md', '../state/current.md')).toBe(
            'state/current.md',
        );
        expect(resolveWikiDocumentPath('overview/conventions.md', '../../secret.md')).toBeNull();
        expect(resolveWikiDocumentPath('INDEX.md', 'https://example.com/a.md')).toBeNull();
        expect(resolveWikiDocumentPath('INDEX.md', '#local')).toBeNull();
    });
});
