import { describe, expect, it } from 'vitest';
import {
    clampPage,
    prettyCellText,
    sizeShare,
    storagePageCount,
    STORAGE_PALETTE,
    tableRowPreview,
    totalTableBytes,
    usageSegments,
    type StorageTableStats,
} from '../src/scripts/storage.ts';

function table(over: Partial<StorageTableStats> & { name: string }): StorageTableStats {
    return {
        columns: [],
        rows: 0,
        bytes: 0,
        indexBytes: 0,
        indexes: 0,
        ...over,
    };
}

describe('storage 纯函数（docs/web/存储面板设计.md §4）', () => {
    it('totalTableBytes 汇总有字节数的表，忽略 null', () => {
        expect(
            totalTableBytes([
                table({ name: 'a', bytes: 100 }),
                table({ name: 'b', bytes: null }),
                table({ name: 'c', bytes: 50 }),
            ]),
        ).toBe(150);
    });

    it('sizeShare 处理 0/非法输入', () => {
        expect(sizeShare(50, 100)).toBe(0.5);
        expect(sizeShare(0, 100)).toBe(0);
        expect(sizeShare(50, 0)).toBe(0);
        expect(sizeShare(null, 100)).toBe(0);
    });

    it('usageSegments 按占用聚合 Top N，其余归入「其他」且占比合计为 1', () => {
        const segments = usageSegments(
            [
                table({ name: 'a', bytes: 60 }),
                table({ name: 'b', bytes: 30 }),
                table({ name: 'c', bytes: 10 }),
            ],
            2,
        );
        expect(segments.map((s) => s.label)).toEqual(['a', 'b', '其他 1 张表']);
        expect(segments[0].share).toBeCloseTo(0.6);
        expect(segments[2].bytes).toBe(10);
        expect(segments.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1);
        expect(segments[0].colorVar).toBe(STORAGE_PALETTE[0]);
    });

    it('usageSegments 无有效字节时返回空数组', () => {
        expect(usageSegments([table({ name: 'a', bytes: null })])).toEqual([]);
    });

    it('tableRowPreview 折叠空白并截断', () => {
        expect(tableRowPreview('hello\n  world', 20)).toBe('hello world');
        expect(tableRowPreview('x'.repeat(10), 4)).toBe('xxxx…');
        expect(tableRowPreview(null)).toBe('');
        expect(tableRowPreview({ a: 1 })).toBe('{"a":1}');
    });

    it('prettyCellText 格式化 JSON，普通文本原样返回', () => {
        expect(prettyCellText('{"a":1}')).toBe('{\n  "a": 1\n}');
        expect(prettyCellText('plain text')).toBe('plain text');
        expect(prettyCellText(null)).toBe('');
    });

    it('分页辅助：页数至少为 1，页码夹在有效区间', () => {
        expect(storagePageCount(0, 50)).toBe(1);
        expect(storagePageCount(51, 50)).toBe(2);
        expect(clampPage(0, 3)).toBe(1);
        expect(clampPage(9, 3)).toBe(3);
        expect(clampPage(2, 3)).toBe(2);
    });
});
