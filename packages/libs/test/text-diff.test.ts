import { describe, expect, it } from 'vitest';
import { diffText, MAX_DIFF_LINES } from '../src/text-diff.js';

describe('diffText（行级 LCS）', () => {
    it('完全相同 → identical，全部 equal，相似度 1', () => {
        const diff = diffText('a\nb', 'a\nb');
        expect(diff.identical).toBe(true);
        expect(diff.rows.map((row) => row.op)).toEqual(['equal', 'equal']);
        expect(diff.similarity).toBe(1);
        expect(diff.added).toBe(0);
        expect(diff.removed).toBe(0);
    });

    it('纯新增 / 纯删除', () => {
        const added = diffText('a', 'a\nb');
        expect(added.added).toBe(1);
        expect(added.removed).toBe(0);
        expect(added.rows[1]).toMatchObject({ op: 'add', a: null, b: 'b', bLine: 2 });

        const removed = diffText('a\nb', 'a');
        expect(removed.removed).toBe(1);
        expect(removed.rows[1]).toMatchObject({ op: 'remove', a: 'b', b: null, aLine: 2 });
    });

    it('混合改动：行号一一对应，相似度在 0-1 之间', () => {
        const diff = diffText('one\ntwo\nthree', 'one\n2\nthree\nfour');
        expect(diff.identical).toBe(false);
        expect(diff.rows.filter((row) => row.op === 'equal')).toHaveLength(2);
        expect(diff.added).toBe(2);
        expect(diff.removed).toBe(1);
        expect(diff.similarity).toBeGreaterThan(0);
        expect(diff.similarity).toBeLessThanOrEqual(1);
    });

    it('两侧皆空 → identical、相似度 1；一边空 → 全部增删', () => {
        expect(diffText('', '')).toMatchObject({ identical: true, similarity: 1, added: 0, removed: 0 });
        const empty = diffText('', 'x\ny');
        expect(empty.added).toBe(2);
        expect(empty.similarity).toBe(0);
    });

    it('超长输入截断并显式标记（不静默）', () => {
        const long = Array.from({ length: MAX_DIFF_LINES + 5 }, (_, index) => 'line' + index).join('\n');
        const diff = diffText(long, long);
        expect(diff.truncated).toBe(true);
        expect(diff.rows.length).toBe(MAX_DIFF_LINES);
    });
});
