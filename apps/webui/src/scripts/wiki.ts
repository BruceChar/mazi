/**
 * 项目 wiki 只读视图的纯函数与类型（docs/项目wiki设计.md §11）。
 * 数据来自 GET /api/wiki；写入侧在 runtime，前端只读。
 */

export interface WikiEntryView {
    ts: string;
    change: string;
}

export interface WikiView {
    project: string;
    workspace: string;
    path: string;
    updatedAt?: string;
    snapshot: string | null;
    entries: WikiEntryView[];
    empty: boolean;
}

export interface WikiSectionView {
    title: string;
    body: string;
}

/** 快照按二级标题切分（与 runtime splitSections 同口径）。 */
export function snapshotSections(snapshot: string | null | undefined): WikiSectionView[] {
    const text = (snapshot ?? '').trim();
    if (text.length === 0) return [];
    const sections: WikiSectionView[] = [];
    let title: string | undefined;
    let buffer: string[] = [];
    const flush = (): void => {
        if (title === undefined) return;
        sections.push({ title, body: buffer.join('\n').trim() });
    };
    for (const line of text.split(/\r?\n/)) {
        if (line.startsWith('## ')) {
            flush();
            title = line.slice(3).trim();
            buffer = [];
            continue;
        }
        if (title === undefined) continue;
        buffer.push(line);
    }
    flush();
    return sections;
}

/** 最近 N 条变更（保持时间升序，取尾部）。 */
export function recentEntries(
    entries: readonly WikiEntryView[] | undefined,
    limit = 20,
): WikiEntryView[] {
    const list = [...(entries ?? [])];
    return limit > 0 ? list.slice(-limit) : list;
}

export function entryCountLabel(count: number): string {
    return count > 0 ? count + ' 条变更' : '暂无变更';
}

/** 头部「最近更新」：ISO → 人读；缺省显示尚未生成。 */
export function wikiUpdatedLabel(updatedAt: string | undefined): string {
    const value = (updatedAt ?? '').trim();
    if (value.length === 0) return '尚未生成';
    return value.replace('T', ' ').replace(/([+-]\d{2}:\d{2})$/, ' $1');
}

export function wikiEmptyText(workspace: string): string {
    if (workspace.trim().length === 0) return '暂无项目 wiki：请先选择工作区。';
    return '暂无项目 wiki：本工作区还没有产生过写入。会话中对项目文件产生改动后会自动记录。';
}
