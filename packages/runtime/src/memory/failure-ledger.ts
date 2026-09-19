/**
 * failure-ledger —— 失败分类账（session/task 终态失败事实）。
 *
 * 只追加、按 createdAt 倒序只读查询；级联删除随 Conversation。
 * 写入点见 docs/web/后端与存储设计.md §5.3：Task 终态失败（aborted 除外）。
 */

import { DatabaseSync } from 'node:sqlite';

export interface FailureLedgerEntry {
    failureId: string;
    /** 运行会话 id（rootGoalId）。 */
    sessionId: string;
    goalId?: string;
    taskId?: string;
    /** 失败类别（TaskStopReason：max-steps / driver-error / blocked-tool …）。 */
    kind: string;
    providerId?: string;
    modelId?: string;
    summary?: string;
    tags?: string[];
    createdAt: number;
}

export interface FailureLedgerQuery {
    kind?: string;
    /** 返回上限（默认 100）。 */
    limit?: number;
}

export interface FailureLedgerStore {
    add(entry: FailureLedgerEntry): Promise<void>;
    list(query?: FailureLedgerQuery): Promise<FailureLedgerEntry[]>;
    /** 级联删除（Conversation 删除用）。 */
    deleteByRoot(rootGoalId: string): Promise<void>;
    close(): void;
}

const DEFAULT_LIMIT = 100;

/** 进程内实现（测试 / 轻量运行）。 */
export class MemoryFailureLedger implements FailureLedgerStore {
    private entries: FailureLedgerEntry[] = [];

    async add(entry: FailureLedgerEntry): Promise<void> {
        this.entries.push(structuredClone(entry));
    }

    async list(query: FailureLedgerQuery = {}): Promise<FailureLedgerEntry[]> {
        let list = [...this.entries].sort((a, b) => b.createdAt - a.createdAt);
        if (query.kind !== undefined) list = list.filter((entry) => entry.kind === query.kind);
        return list.slice(0, query.limit ?? DEFAULT_LIMIT).map((entry) => structuredClone(entry));
    }

    async deleteByRoot(rootGoalId: string): Promise<void> {
        this.entries = this.entries.filter((entry) => entry.sessionId !== rootGoalId);
    }

    close(): void {}
}

/** node:sqlite 落地实现（独立连接；表懒建）。 */
export class SqliteFailureLedger implements FailureLedgerStore {
    private readonly db: DatabaseSync;

    constructor(dbPath: string) {
        this.db = new DatabaseSync(dbPath);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS failure_ledger (
                failure_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_failure_ledger_kind ON failure_ledger(kind, created_at);
            CREATE INDEX IF NOT EXISTS idx_failure_ledger_session ON failure_ledger(session_id);
        `);
    }

    async add(entry: FailureLedgerEntry): Promise<void> {
        this.db
            .prepare(
                'INSERT OR REPLACE INTO failure_ledger (failure_id, session_id, kind, created_at, json) VALUES (?, ?, ?, ?, ?)',
            )
            .run(
                entry.failureId,
                entry.sessionId,
                entry.kind,
                entry.createdAt,
                JSON.stringify(entry),
            );
    }

    async list(query: FailureLedgerQuery = {}): Promise<FailureLedgerEntry[]> {
        const limit = query.limit ?? DEFAULT_LIMIT;
        const rows = (
            query.kind !== undefined
                ? this.db
                      .prepare(
                          'SELECT json FROM failure_ledger WHERE kind = ? ORDER BY created_at DESC LIMIT ?',
                      )
                      .all(query.kind, limit)
                : this.db
                      .prepare('SELECT json FROM failure_ledger ORDER BY created_at DESC LIMIT ?')
                      .all(limit)
        ) as Array<{ json: string }>;
        return rows.map((row) => JSON.parse(row.json) as FailureLedgerEntry);
    }

    async deleteByRoot(rootGoalId: string): Promise<void> {
        this.db.prepare('DELETE FROM failure_ledger WHERE session_id = ?').run(rootGoalId);
    }

    close(): void {
        this.db.close();
    }
}
