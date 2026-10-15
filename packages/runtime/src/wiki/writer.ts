import { type Dirent, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { formatLocalTimestamp, type WikiEntry, type WikiStore } from './store.js';
import { changedModules, type WikiSummarizer } from './summarizer.js';

/** 变更扫描忽略的目录名（node_modules/.git 等；设计 §7.1）。 */
export const DEFAULT_IGNORED_DIRS = [
    'node_modules',
    '.git',
    'dist',
    '.turbo',
    '.next',
    'coverage',
    '.pnpm-store',
    '.pnpm-local-store',
];
export const MAX_SCAN_ENTRIES = 20000;
/** 累计变更达到该条数即刷新状态快照（设计 §12）。 */
export const DEFAULT_SNAPSHOT_THRESHOLD = 10;

export interface WorkspaceFileStamp {
    size: number;
    mtimeMs: number;
}

export type WorkspaceScan = Map<string, WorkspaceFileStamp>;

export interface ScanOptions {
    ignore?: readonly string[];
    maxEntries?: number;
}

export function isIgnoredPath(
    path: string,
    ignore: readonly string[] = DEFAULT_IGNORED_DIRS,
): boolean {
    return path.split(/[\\/]+/).some((segment) => ignore.includes(segment));
}

/** 工作区轻量快照：相对路径 → size/mtimeMs（非 git 仓库同样可用；设计 §7.2）。 */
export function scanWorkspace(workspace: string, options: ScanOptions = {}): WorkspaceScan {
    const ignore = options.ignore ?? DEFAULT_IGNORED_DIRS;
    const maxEntries = options.maxEntries ?? MAX_SCAN_ENTRIES;
    const scan: WorkspaceScan = new Map();
    const walk = (dir: string): void => {
        if (scan.size >= maxEntries) return;
        let entries: Dirent[];
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (scan.size >= maxEntries) return;
            if (ignore.includes(entry.name)) continue;
            const absolute = join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(absolute);
                continue;
            }
            if (!entry.isFile()) continue;
            try {
                const stat = statSync(absolute);
                scan.set(relative(workspace, absolute).split(sep).join('/'), {
                    size: stat.size,
                    mtimeMs: stat.mtimeMs,
                });
            } catch {
                // 扫描期文件被删除：忽略
            }
        }
    };
    walk(workspace);
    return scan;
}

export function diffWorkspace(
    before: WorkspaceScan,
    after: WorkspaceScan,
): { added: string[]; modified: string[]; deleted: string[] } {
    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];
    for (const [path, stamp] of after) {
        const previous = before.get(path);
        if (previous === undefined) {
            added.push(path);
            continue;
        }
        if (previous.size !== stamp.size || previous.mtimeMs !== stamp.mtimeMs) modified.push(path);
    }
    for (const path of before.keys()) {
        if (!after.has(path)) deleted.push(path);
    }
    return { added: added.sort(), modified: modified.sort(), deleted: deleted.sort() };
}

export interface PendingWrite {
    ts: string;
    tool: string;
    /** 工具参数里可解析出的目标路径（相对工作区）；为空时依赖兜底 diff。 */
    paths: string[];
}

export interface WikiFlushContext {
    sessionId?: string;
    userRequest?: string;
    answer?: string;
}

export interface WikiFlushResult {
    entries: WikiEntry[];
    snapshotRefreshed: boolean;
}

export interface WikiWriterOptions {
    store: WikiStore;
    workspace: string;
    summarizer: WikiSummarizer;
    now?: () => Date;
    snapshotThreshold?: number;
    ignore?: readonly string[];
    maxScanEntries?: number;
}

/**
 * 变更写入器：写工具逐次记 pending，回合末合并兜底 diff 后生成功能级条目（设计 §7）。
 */
export class WikiWriter {
    private readonly store: WikiStore;
    private readonly workspace: string;
    private readonly summarizer: WikiSummarizer;
    private readonly now: () => Date;
    private readonly snapshotThreshold: number;
    private readonly ignore: readonly string[];
    private readonly maxScanEntries: number;
    private pending: PendingWrite[] = [];
    private baseline: WorkspaceScan | undefined;
    private sinceSnapshot = 0;

    constructor(options: WikiWriterOptions) {
        this.store = options.store;
        this.workspace = options.workspace;
        this.summarizer = options.summarizer;
        this.now = options.now ?? (() => new Date());
        this.snapshotThreshold = options.snapshotThreshold ?? DEFAULT_SNAPSHOT_THRESHOLD;
        this.ignore = options.ignore ?? DEFAULT_IGNORED_DIRS;
        this.maxScanEntries = options.maxScanEntries ?? MAX_SCAN_ENTRIES;
    }

    get pendingCount(): number {
        return this.pending.length;
    }

    /** 会话/回合开始：建立兜底 diff 基线。 */
    beginRun(): void {
        this.baseline = this.scan();
    }

    /** 写工具成功后记录一条 pending。 */
    record(tool: string, paths: readonly string[] = []): void {
        this.pending.push({
            ts: formatLocalTimestamp(this.now()),
            tool,
            paths: paths.map((path) => this.toRelative(path)).filter((path) => path.length > 0),
        });
    }

    /** 回合末：合并 pending + 兜底 diff → 摘要 → 追加条目（必要时刷新快照）。 */
    async flushRun(context: WikiFlushContext = {}): Promise<WikiFlushResult> {
        const pending = this.pending;
        this.pending = [];
        const after = this.scan();
        const diff =
            this.baseline !== undefined
                ? diffWorkspace(this.baseline, after)
                : { added: [], modified: [], deleted: [] };
        this.baseline = after;
        const paths = new Set<string>();
        for (const item of pending) {
            for (const path of item.paths) paths.add(path);
        }
        for (const path of [...diff.added, ...diff.modified, ...diff.deleted]) paths.add(path);
        const changedPaths = [...paths]
            .filter(
                (path) =>
                    path.length > 0 && !path.startsWith('..') && !isIgnoredPath(path, this.ignore),
            )
            .sort();
        if (changedPaths.length === 0) {
            return { entries: [], snapshotRefreshed: false };
        }
        const tools = [...new Set(pending.map((item) => item.tool))].sort();
        const facts = {
            project: this.store.project,
            workspace: this.workspace,
            changedPaths,
            tools,
            ...(context.userRequest !== undefined ? { userRequest: context.userRequest } : {}),
            ...(context.answer !== undefined ? { answer: context.answer } : {}),
        };
        const changes = await this.summarizer.summarizeChanges(facts);
        const ts = formatLocalTimestamp(this.now());
        const entries: WikiEntry[] = (changes.length > 0 ? changes : ['项目文件有改动']).map(
            (change) => ({ ts, change }),
        );
        await this.store.appendEntries(entries, {
            ...(context.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
        });
        this.sinceSnapshot += entries.length;
        let snapshotRefreshed = false;
        if (this.sinceSnapshot >= this.snapshotThreshold) {
            const current = this.store.read();
            const snapshot = await this.summarizer.refreshSnapshot({
                project: this.store.project,
                workspace: this.workspace,
                currentSnapshot: current?.snapshot ?? '',
                recentEntries: (current?.entries ?? []).slice(-10),
                changedPaths,
            });
            if (snapshot !== undefined && snapshot.trim().length > 0) {
                await this.store.writeSnapshot(snapshot, {
                    ...(context.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
                });
                snapshotRefreshed = true;
                this.sinceSnapshot = 0;
            }
        }
        return { entries, snapshotRefreshed };
    }

    /** 当前待刷新变更模块（调用方日志/测试用）。 */
    pendingModules(): string[] {
        return changedModules(this.pending.flatMap((item) => item.paths));
    }

    private scan(): WorkspaceScan {
        return scanWorkspace(this.workspace, {
            ignore: this.ignore,
            maxEntries: this.maxScanEntries,
        });
    }

    private toRelative(path: string): string {
        const absolute = isAbsolute(path) ? path : join(this.workspace, path);
        return relative(this.workspace, absolute).split(sep).join('/');
    }
}
