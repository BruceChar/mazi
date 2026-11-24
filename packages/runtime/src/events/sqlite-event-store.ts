/**
 * SqliteEventStore —— 事件权威存储（R5）：新事件写入 SQLite，按类型/时间/根目标
 * 建索引，替代 JSONL 全量扫描。整行存 event_json，查询列冗余抽出。
 *
 * 只读查询与 append；不负责链式重算（链由 EventBus 赋予），只持久化。
 */
import { DatabaseSync } from 'node:sqlite';
import type { HarnessEvent } from '@mazi/core';

/** 事件查询过滤（审计走索引，不全表扫）。 */
export interface EventQuery {
    types?: readonly string[];
    from?: number;
    to?: number;
    rootGoalId?: string;
}

export interface ChainHead {
    seq: number;
    hash?: string;
}

export class SqliteEventStore {
    private readonly db: DatabaseSync;

    constructor(dbPath: string) {
        this.db = new DatabaseSync(dbPath);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS events (
                event_id    TEXT PRIMARY KEY,
                root_goal_id TEXT NOT NULL,
                seq         INTEGER,
                type        TEXT NOT NULL,
                timestamp   INTEGER NOT NULL,
                actor       TEXT,
                session_id  TEXT,
                prev_hash   TEXT,
                hash        TEXT,
                event_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_events_root_seq ON events(root_goal_id, seq);
            CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(type, timestamp);
            CREATE INDEX IF NOT EXISTS idx_events_ts ON events(timestamp);
        `);
    }

    /** 追加（按 event_id 幂等去重）。 */
    append(event: HarnessEvent): void {
        this.db
            .prepare(
                `INSERT OR REPLACE INTO events
                 (event_id, root_goal_id, seq, type, timestamp, actor, session_id, prev_hash, hash, event_json)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                event.eventId,
                event.rootGoalId,
                event.seq ?? null,
                event.type,
                event.timestamp,
                event.actor ?? null,
                event.sessionId ?? null,
                event.prevHash ?? null,
                event.hash ?? null,
                JSON.stringify(event),
            );
    }

    /** 单根回放：按 seq 升序。 */
    replay(rootGoalId: string): HarnessEvent[] {
        const rows = this.db
            .prepare(
                `SELECT event_json FROM events WHERE root_goal_id = ? ORDER BY seq ASC, timestamp ASC`,
            )
            .all(rootGoalId) as Array<{ event_json: string }>;
        return rows.map((row) => JSON.parse(row.event_json) as HarnessEvent);
    }

    /** 按类型 / 时间范围 / 根目标裁剪，按时间升序。 */
    query(filter: EventQuery = {}): HarnessEvent[] {
        const where: string[] = [];
        const params: Array<string | number> = [];
        if (filter.rootGoalId !== undefined) {
            where.push('root_goal_id = ?');
            params.push(filter.rootGoalId);
        }
        if (filter.types !== undefined && filter.types.length > 0) {
            where.push(`type IN (${filter.types.map(() => '?').join(', ')})`);
            params.push(...filter.types);
        }
        if (filter.from !== undefined) {
            where.push('timestamp >= ?');
            params.push(filter.from);
        }
        if (filter.to !== undefined) {
            where.push('timestamp <= ?');
            params.push(filter.to);
        }
        const sql = `SELECT event_json FROM events${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY timestamp ASC`;
        const rows = this.db.prepare(sql).all(...params) as Array<{ event_json: string }>;
        return rows.map((row) => JSON.parse(row.event_json) as HarnessEvent);
    }

    /** 最新链式头（seq/hash）；无记录返回 genesis 空头。 */
    chainHead(rootGoalId: string): ChainHead {
        const row = this.db
            .prepare(
                `SELECT seq, hash FROM events WHERE root_goal_id = ? ORDER BY seq DESC LIMIT 1`,
            )
            .get(rootGoalId) as { seq: number | null; hash: string | null } | undefined;
        if (row === undefined || row.seq === null) return { seq: 0 };
        return { seq: row.seq, ...(row.hash !== null ? { hash: row.hash } : {}) };
    }

    close(): void {
        this.db.close();
    }
}
