/**
 * text-diff —— 行级文本对比（纯函数，api 与 webui 共享）。
 *
 * 用途：实验台并排展示 A/B 两臂最终输出。只做确定性投影，不做语义评分
 * （对比口径见 docs/AB测试设计.md §5）。
 *
 * 规模约束：LCS 为 O(n·m)。为避免极端输出拖垮浏览器，超过 MAX_DIFF_LINES 时
 * 截断并置 truncated=true（截断是显式事实，不静默）。
 */

/** 单行对比结果：equal 两侧都有；add 只在 B；remove 只在 A。 */
export interface DiffRow {
    op: 'equal' | 'add' | 'remove';
    a: string | null;
    b: string | null;
    /** 1-based 行号；该侧不存在为 null。 */
    aLine: number | null;
    bLine: number | null;
}

export interface TextDiff {
    rows: DiffRow[];
    added: number;
    removed: number;
    unchanged: number;
    /** 2·unchanged / (a 行数 + b 行数)；两侧皆空 = 1。 */
    similarity: number;
    identical: boolean;
    /** 任一侧超过 MAX_DIFF_LINES 时为 true（结果基于截断后的文本）。 */
    truncated: boolean;
}

export const MAX_DIFF_LINES = 1500;

function splitLines(text: string): string[] {
    return text.length === 0 ? [] : text.split('\n');
}

/** 行级对比（LCS）。 */
export function diffText(a: string, b: string): TextDiff {
    const allA = splitLines(a);
    const allB = splitLines(b);
    const truncated = allA.length > MAX_DIFF_LINES || allB.length > MAX_DIFF_LINES;
    const left = truncated ? allA.slice(0, MAX_DIFF_LINES) : allA;
    const right = truncated ? allB.slice(0, MAX_DIFF_LINES) : allB;

    const n = left.length;
    const m = right.length;
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
            table[i * width + j] =
                left[i] === right[j]
                    ? (table[(i + 1) * width + (j + 1)] ?? 0) + 1
                    : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + (j + 1)] ?? 0);
        }
    }

    const rows: DiffRow[] = [];
    let i = 0;
    let j = 0;
    let added = 0;
    let removed = 0;
    let unchanged = 0;
    while (i < n && j < m) {
        if (left[i] === right[j]) {
            rows.push({
                op: 'equal',
                a: left[i] ?? '',
                b: right[j] ?? '',
                aLine: i + 1,
                bLine: j + 1,
            });
            unchanged += 1;
            i += 1;
            j += 1;
        } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + (j + 1)] ?? 0)) {
            rows.push({ op: 'remove', a: left[i] ?? '', b: null, aLine: i + 1, bLine: null });
            removed += 1;
            i += 1;
        } else {
            rows.push({ op: 'add', a: null, b: right[j] ?? '', aLine: null, bLine: j + 1 });
            added += 1;
            j += 1;
        }
    }
    while (i < n) {
        rows.push({ op: 'remove', a: left[i] ?? '', b: null, aLine: i + 1, bLine: null });
        removed += 1;
        i += 1;
    }
    while (j < m) {
        rows.push({ op: 'add', a: null, b: right[j] ?? '', aLine: null, bLine: j + 1 });
        added += 1;
        j += 1;
    }

    const total = n + m;
    return {
        rows,
        added,
        removed,
        unchanged,
        similarity: total === 0 ? 1 : (2 * unchanged) / total,
        identical: added === 0 && removed === 0,
        truncated,
    };
}
