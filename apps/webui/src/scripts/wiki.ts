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
    repository?: WikiRepositoryView | null;
    operation?: WikiOperationView | null;
    backgroundSync?: WikiOperationView | null;
}

export interface WikiSectionView {
    title: string;
    body: string;
}

export type WikiDocumentGroup = 'index' | 'overview' | 'state' | 'decisions' | 'lessons' | 'other';

export interface WikiDocumentView {
    path: string;
    title: string;
    group: WikiDocumentGroup;
    content: string;
}

export type WikiClaimStatus = 'active' | 'stale' | 'missing' | 'retracted';

export interface WikiClaimView {
    id: string;
    text: string;
    status: WikiClaimStatus;
    retractionKind?: 'forgotten' | 'corrected' | 'obsolete';
    supersededBy?: string;
    supersedes?: string;
    retractedReason?: string;
    evidence: Array<{
        file: string;
        hint?: string;
        status: Exclude<WikiClaimStatus, 'retracted'>;
    }>;
}

export interface WikiRepositoryView {
    root: string;
    indexPath: string;
    index: string;
    docs: WikiDocumentView[];
    claims: WikiClaimView[];
    summary: {
        documents: number;
        claims: number;
        active: number;
        stale: number;
        missing: number;
        retracted: number;
        forgotten: number;
    };
    latestCommit?: {
        hash: string;
        subject: string;
        committedAt: string;
    };
}

export interface WikiOperationView {
    id: string;
    kind: 'init' | 'update' | 'sync';
    workspace: string;
    state: 'queued' | 'running' | 'succeeded' | 'failed';
    startedAt: number;
    finishedAt?: number;
    rootGoalId?: string;
    sourceSessionId?: string;
    summary?: string;
    error?: string;
    approvalPending?: boolean;
    lastHeartbeatAt?: number;
    trace?: Array<{
        timestamp: number;
        type: string;
        label: string;
    }>;
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

/**
 * 从项目「…」菜单打开 wiki 时的目标工作区：项目路径优先，缺省回退当前会话工作区。
 */
export function wikiWorkspaceFor(projectPath: string | undefined, headerWorkspace: string): string {
    const project = (projectPath ?? '').trim();
    return project.length > 0 ? project : headerWorkspace.trim();
}

export function entryCountLabel(count: number): string {
    return count > 0 ? `${count} 条变更` : '暂无变更';
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

export function wikiDocumentLabel(doc: Pick<WikiDocumentView, 'path' | 'title'>): string {
    const known: Record<string, string> = {
        'INDEX.md': '项目索引',
        'overview/architecture.md': '项目全貌',
        'overview/conventions.md': '工作方式',
        'overview/commands.md': '常用流程',
        'overview/deployment.md': '环境与交付',
        'state/current.md': '当前状态',
        'state/lessons/README.md': '经验教训',
        'overview/decisions/README.md': '决策记录',
    };
    return known[doc.path] ?? doc.title;
}

export function wikiDocumentGroupLabel(group: WikiDocumentGroup): string {
    return {
        index: '入口',
        overview: '项目知识',
        state: '实时状态',
        decisions: '决策',
        lessons: '经验',
        other: '其他',
    }[group];
}

export function wikiClaimStatusLabel(status: WikiClaimStatus): string {
    return {
        active: '有效',
        stale: '待复核',
        missing: '证据缺失',
        retracted: '已撤回',
    }[status];
}

export function wikiClaimDisplayStatus(
    claim: Pick<WikiClaimView, 'status' | 'retractionKind'>,
): string {
    if (claim.status !== 'retracted') return wikiClaimStatusLabel(claim.status);
    if (claim.retractionKind === 'forgotten') return '已遗忘';
    if (claim.retractionKind === 'corrected') return '已被纠正';
    return '已撤回';
}

export function wikiClaimsAttention(summary: WikiRepositoryView['summary'] | undefined): number {
    return (summary?.stale ?? 0) + (summary?.missing ?? 0);
}

export function wikiRepositoryEmptyText(repository: WikiRepositoryView | null | undefined): string {
    if (repository === null || repository === undefined) {
        return '本项目还没有 v2 知识库。初始化后，这里会按索引、项目知识、当前状态和事实证据展示。';
    }
    return repository.docs.length === 0
        ? '知识库还没有文档。补充 INDEX.md 或 overview/ 下的内容后会显示在这里。'
        : '';
}

/** Resolve a relative Markdown link inside the wiki without leaving its root. */
export function resolveWikiDocumentPath(fromPath: string, href: string): string | null {
    const value = href.split('#')[0]?.trim() ?? '';
    if (!value || /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//')) return null;
    if (!value.toLowerCase().endsWith('.md')) return null;
    const segments = (value.startsWith('/') ? [] : fromPath.split('/').slice(0, -1))
        .concat(value.replace(/^\/+/, '').split('/'))
        .filter((segment) => segment.length > 0 && segment !== '.');
    const normalized: string[] = [];
    for (const segment of segments) {
        if (segment === '..') {
            if (normalized.length === 0) return null;
            normalized.pop();
        } else {
            normalized.push(segment);
        }
    }
    return normalized.join('/');
}
