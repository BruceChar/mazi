import { type Dirent, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
    normalizeWorkspace,
    projectNameFor,
    wikiDirFor,
    wikiFileFor,
    wikiIndexFile,
    wikiRoot,
    type WikiProjectIndex,
} from './naming.js';

/** 变更日志区标题（append-only 分界；设计 §4.2）。 */
export const WIKI_LOG_HEADING = '## 变更日志';
export const WIKI_LOG_COMMENT = '<!-- append-only；harness 只追加，不改写历史行 -->';
export const WIKI_BACKUP_SUFFIX = '.bak';
/** 变更日志保留条数上限，超出折叠最旧条目（设计 §7.3）。 */
export const DEFAULT_LOG_LIMIT = 500;

export interface WikiEntry {
    /** 本地时间 YYYY-MM-DD HH:mm:ss（人读；设计 §4.2）。 */
    ts: string;
    /** 功能级改动描述（不下沉到文件；设计 §7.3）。 */
    change: string;
}

export interface WikiDoc {
    project: string;
    workspace: string;
    updatedAt?: string;
    sessionId?: string;
    /** 变更日志标题之前的状态快照区。 */
    snapshot: string;
    entries: WikiEntry[];
}

function pad(value: number, width = 2): string {
    return String(value).padStart(width, '0');
}

/** 本地时间 YYYY-MM-DD HH:mm:ss（变更日志条目的时间列）。 */
export function formatLocalTimestamp(date: Date = new Date()): string {
    return (
        date.getFullYear() +
        '-' +
        pad(date.getMonth() + 1) +
        '-' +
        pad(date.getDate()) +
        ' ' +
        pad(date.getHours()) +
        ':' +
        pad(date.getMinutes()) +
        ':' +
        pad(date.getSeconds())
    );
}

/** 本地时间带时区偏移的 ISO 串（文件头部「最近更新」）。 */
export function formatIsoTimestamp(date: Date = new Date()): string {
    const offset = -date.getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    const absolute = Math.abs(offset);
    return (
        date.getFullYear() +
        '-' +
        pad(date.getMonth() + 1) +
        '-' +
        pad(date.getDate()) +
        'T' +
        pad(date.getHours()) +
        ':' +
        pad(date.getMinutes()) +
        ':' +
        pad(date.getSeconds()) +
        sign +
        pad(Math.floor(absolute / 60)) +
        ':' +
        pad(absolute % 60)
    );
}

/** 文件是否具备 wiki 骨架（标题或变更日志区）；用于损坏判定（设计 §14）。 */
export function looksLikeWiki(raw: string): boolean {
    return raw.includes(WIKI_LOG_HEADING) || /^#{1,2}\s/m.test(raw);
}

function metaValue(meta: string | undefined, label: string): string | undefined {
    if (meta === undefined) return undefined;
    const index = meta.indexOf(label + '：');
    if (index < 0) return undefined;
    const rest = meta.slice(index + label.length + 1);
    const end = rest.indexOf('｜');
    const value = (end >= 0 ? rest.slice(0, end) : rest).trim();
    return value.length > 0 ? value : undefined;
}

export function parseWikiMarkdown(project: string, workspace: string, raw: string): WikiDoc {
    const lines = raw.split(/\r?\n/);
    let meta: string | undefined;
    let cursor = 0;
    while (cursor < lines.length) {
        const line = lines[cursor].trim();
        if (line.startsWith('>')) {
            meta = line.replace(/^>\s*/, '');
            cursor += 1;
            continue;
        }
        if (line.length === 0 || line.startsWith('# ')) {
            cursor += 1;
            continue;
        }
        break;
    }
    const snapshotLines: string[] = [];
    const logLines: string[] = [];
    let inLog = false;
    for (let index = cursor; index < lines.length; index += 1) {
        const line = lines[index];
        if (!inLog && line.trim() === WIKI_LOG_HEADING) {
            inLog = true;
            continue;
        }
        if (inLog) logLines.push(line);
        else snapshotLines.push(line);
    }
    const entries: WikiEntry[] = [];
    for (const line of logLines) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith('<!--')) continue;
        const body = trimmed.startsWith('-') ? trimmed.slice(1).trim() : trimmed;
        const separator = body.indexOf('|');
        if (separator < 0) continue;
        const ts = body.slice(0, separator).trim();
        const change = body.slice(separator + 1).trim();
        if (ts.length === 0 || change.length === 0) continue;
        entries.push({ ts, change });
    }
    const updatedAt = metaValue(meta, '最近更新');
    const sessionId = metaValue(meta, '会话');
    // 调用方未提供工作区时（如 /list 目录扫描）回落到文件头部记录的工作区
    const resolvedWorkspace = workspace.length > 0 ? workspace : (metaValue(meta, '工作区') ?? '');
    return {
        project,
        workspace: resolvedWorkspace,
        ...(updatedAt !== undefined ? { updatedAt } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        snapshot: snapshotLines.join('\n').trim(),
        entries,
    };
}

export function renderWikiMarkdown(doc: WikiDoc): string {
    const metaParts = ['项目：' + doc.project, '工作区：' + doc.workspace];
    if (doc.updatedAt !== undefined) metaParts.push('最近更新：' + doc.updatedAt);
    if (doc.sessionId !== undefined) metaParts.push('会话：' + doc.sessionId);
    const entryLines = doc.entries.map((entry) => '- ' + entry.ts + ' | ' + entry.change);
    return [
        '# ' + doc.project + ' 项目 wiki',
        '',
        '> ' + metaParts.join(' ｜ '),
        '',
        doc.snapshot.trim(),
        '',
        WIKI_LOG_HEADING,
        WIKI_LOG_COMMENT,
        ...entryLines,
        '',
    ].join('\n');
}

/** 超出上限时把最旧的若干条折叠成一条（保留时间锚点）。 */
export function foldEntries(entries: readonly WikiEntry[], limit: number): WikiEntry[] {
    if (limit <= 0 || entries.length <= limit) return [...entries];
    const drop = entries.length - limit + 1;
    const oldest = entries[0];
    return [{ ts: oldest.ts, change: '更早 ' + drop + ' 条变更已折叠' }, ...entries.slice(drop)];
}

/** 读取项目索引（缺失/损坏 → 空索引）。 */
export function readWikiIndex(home: string): WikiProjectIndex {
    try {
        const parsed = JSON.parse(readFileSync(wikiIndexFile(home), 'utf8')) as unknown;
        if (parsed !== null && typeof parsed === 'object') return parsed as WikiProjectIndex;
    } catch {
        // 索引缺失或损坏：按空索引处理（主文件仍是权威）
    }
    return {};
}

function writeAtomic(file: string, content: string): void {
    mkdirSync(dirname(file), { recursive: true });
    const temporary = file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
    writeFileSync(temporary, content, 'utf8');
    renameSync(temporary, file);
}

function writeWikiIndex(home: string, index: WikiProjectIndex): void {
    writeAtomic(wikiIndexFile(home), JSON.stringify(index, null, 2) + '\n');
}

/** 同一路径的读写串行化（进程内；跨进程退化为最后写入胜出，设计 §13）。 */
const fileLocks = new Map<string, Promise<unknown>>();

function withFileLock<T>(key: string, task: () => T | Promise<T>): Promise<T> {
    const previous = fileLocks.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    fileLocks.set(
        key,
        next.then(
            () => undefined,
            () => undefined,
        ),
    );
    return next;
}

export interface WikiProjectSummary {
    project: string;
    workspace: string;
    updatedAt?: string;
    entries: number;
}

/** 列出 $MAZI_HOME/wiki 下的项目（索引 + 目录扫描；API /api/wiki/list 用）。 */
export function listProjectWikis(home: string): WikiProjectSummary[] {
    const summaries = new Map<string, WikiProjectSummary>();
    for (const [project, entry] of Object.entries(readWikiIndex(home))) {
        summaries.set(project, {
            project,
            workspace: entry.workspace,
            ...(entry.updatedAt !== undefined ? { updatedAt: entry.updatedAt } : {}),
            entries: 0,
        });
    }
    let projects: Dirent[];
    try {
        projects = readdirSync(wikiRoot(home), { withFileTypes: true });
    } catch {
        return sortSummaries(summaries);
    }
    for (const project of projects) {
        if (!project.isDirectory()) continue;
        let raw: string;
        try {
            raw = readFileSync(wikiFileFor(home, project.name), 'utf8');
        } catch {
            continue;
        }
        const known = summaries.get(project.name);
        const doc = parseWikiMarkdown(project.name, known?.workspace ?? '', raw);
        summaries.set(project.name, {
            project: project.name,
            workspace: doc.workspace,
            ...(doc.updatedAt !== undefined ? { updatedAt: doc.updatedAt } : {}),
            entries: doc.entries.length,
        });
    }
    return sortSummaries(summaries);
}

function sortSummaries(summaries: Map<string, WikiProjectSummary>): WikiProjectSummary[] {
    return [...summaries.values()].sort(
        (left, right) =>
            (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '') ||
            left.project.localeCompare(right.project),
    );
}

export interface WikiStoreOptions {
    home: string;
    workspace: string;
    /** 显式项目名（缺省由工作区 + 索引推导）。 */
    project?: string;
    logLimit?: number;
    now?: () => Date;
}

/** 单文件 wiki 存储：解析/渲染状态快照区与 append-only 变更日志区。 */
export class WikiStore {
    readonly home: string;
    readonly workspace: string;
    readonly project: string;
    readonly dir: string;
    readonly file: string;
    private readonly logLimit: number;
    private readonly now: () => Date;

    constructor(options: WikiStoreOptions) {
        this.home = options.home;
        this.workspace = normalizeWorkspace(options.workspace);
        this.project = options.project ?? projectNameFor(this.workspace, readWikiIndex(this.home));
        this.dir = wikiDirFor(this.home, this.project);
        this.file = wikiFileFor(this.home, this.project);
        this.logLimit = options.logLimit ?? DEFAULT_LOG_LIMIT;
        this.now = options.now ?? (() => new Date());
    }

    exists(): boolean {
        return existsSync(this.file);
    }

    /** 读取；文件缺失/损坏返回 undefined（损坏时备份为 wiki.md.bak）。 */
    read(): WikiDoc | undefined {
        let raw: string;
        try {
            raw = readFileSync(this.file, 'utf8');
        } catch {
            return undefined;
        }
        const doc = parseWikiMarkdown(this.project, this.workspace, raw);
        if (!looksLikeWiki(raw) || (doc.snapshot.length === 0 && doc.entries.length === 0)) {
            try {
                writeFileSync(this.file + WIKI_BACKUP_SUFFIX, raw, 'utf8');
            } catch {
                // 备份失败不阻断会话
            }
            return undefined;
        }
        return doc;
    }

    /** 追加变更日志条目（只动日志区）。 */
    appendEntries(entries: readonly WikiEntry[], meta: { sessionId?: string } = {}): Promise<WikiDoc> {
        return this.mutate((current) => {
            const base = current ?? this.emptyDoc(meta.sessionId);
            return {
                ...base,
                entries: [...base.entries, ...entries],
                updatedAt: formatIsoTimestamp(this.now()),
                ...(meta.sessionId !== undefined ? { sessionId: meta.sessionId } : {}),
            };
        });
    }

    /** 整体替换状态快照区（日志区保持不变）。 */
    writeSnapshot(snapshot: string, meta: { sessionId?: string } = {}): Promise<WikiDoc> {
        return this.mutate((current) => {
            const base = current ?? this.emptyDoc(meta.sessionId);
            return {
                ...base,
                snapshot: snapshot.trim(),
                updatedAt: formatIsoTimestamp(this.now()),
                ...(meta.sessionId !== undefined ? { sessionId: meta.sessionId } : {}),
            };
        });
    }

    private emptyDoc(sessionId?: string): WikiDoc {
        return {
            project: this.project,
            workspace: this.workspace,
            snapshot: '',
            entries: [],
            ...(sessionId !== undefined ? { sessionId } : {}),
        };
    }

    private mutate(update: (current: WikiDoc | undefined) => WikiDoc): Promise<WikiDoc> {
        return withFileLock(this.file, () => {
            const current = this.read();
            const next = update(current);
            const folded: WikiDoc = { ...next, entries: foldEntries(next.entries, this.logLimit) };
            writeAtomic(this.file, renderWikiMarkdown(folded));
            this.touchIndex(folded);
            return folded;
        });
    }

    private touchIndex(doc: WikiDoc): void {
        try {
            const index = readWikiIndex(this.home);
            index[this.project] = {
                workspace: this.workspace,
                ...(doc.updatedAt !== undefined ? { updatedAt: doc.updatedAt } : {}),
            };
            writeWikiIndex(this.home, index);
        } catch {
            // 索引失败不影响主文件
        }
    }
}
