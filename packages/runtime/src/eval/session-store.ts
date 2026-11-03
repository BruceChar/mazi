import { DatabaseSync } from 'node:sqlite';
import type { SessionEvaluationRecord, SessionEvaluationSource } from './session-eval.js';

export interface SessionEvaluationFilter {
    projectId?: string;
    rootGoalId?: string;
    source?: SessionEvaluationSource;
    from?: number;
    to?: number;
    limit?: number;
}

export interface SessionEvaluationStore {
    list(filter?: SessionEvaluationFilter): Promise<SessionEvaluationRecord[]>;
    get(rootGoalId: string): Promise<SessionEvaluationRecord | undefined>;
    save(record: SessionEvaluationRecord): Promise<void>;
    close(): void;
}

export class MemorySessionEvaluationStore implements SessionEvaluationStore {
    private readonly records = new Map<string, SessionEvaluationRecord>();

    async list(filter: SessionEvaluationFilter = {}): Promise<SessionEvaluationRecord[]> {
        return [...this.records.values()]
            .filter((record) => matches(record, filter))
            .sort((left, right) => right.completedAt - left.completedAt)
            .slice(0, filter.limit ?? 200)
            .map((record) => structuredClone(record));
    }

    async get(rootGoalId: string): Promise<SessionEvaluationRecord | undefined> {
        return structuredClone(this.records.get(rootGoalId));
    }

    async save(record: SessionEvaluationRecord): Promise<void> {
        this.records.set(record.rootGoalId, structuredClone(record));
    }

    close(): void {}
}

function matches(record: SessionEvaluationRecord, filter: SessionEvaluationFilter): boolean {
    if (filter.projectId !== undefined && record.projectId !== filter.projectId) return false;
    if (filter.rootGoalId !== undefined && record.rootGoalId !== filter.rootGoalId) return false;
    if (filter.source !== undefined && record.source !== filter.source) return false;
    if (filter.from !== undefined && record.completedAt < filter.from) return false;
    if (filter.to !== undefined && record.completedAt > filter.to) return false;
    return true;
}

export class SqliteSessionEvaluationStore implements SessionEvaluationStore {
    private readonly db: DatabaseSync;

    constructor(dbPath: string) {
        this.db = new DatabaseSync(dbPath);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS session_evaluations (
                evaluation_id TEXT PRIMARY KEY,
                root_goal_id TEXT NOT NULL UNIQUE,
                source TEXT NOT NULL,
                project_id TEXT,
                status TEXT NOT NULL,
                success INTEGER NOT NULL,
                started_at INTEGER NOT NULL,
                completed_at INTEGER NOT NULL,
                json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_session_evaluations_project
                ON session_evaluations(project_id, completed_at DESC);
            CREATE INDEX IF NOT EXISTS idx_session_evaluations_source
                ON session_evaluations(source, completed_at DESC);
        `);
    }

    async list(filter: SessionEvaluationFilter = {}): Promise<SessionEvaluationRecord[]> {
        const clauses: string[] = [];
        const values: Array<string | number> = [];
        if (filter.projectId !== undefined) {
            clauses.push('project_id = ?');
            values.push(filter.projectId);
        }
        if (filter.rootGoalId !== undefined) {
            clauses.push('root_goal_id = ?');
            values.push(filter.rootGoalId);
        }
        if (filter.source !== undefined) {
            clauses.push('source = ?');
            values.push(filter.source);
        }
        if (filter.from !== undefined) {
            clauses.push('completed_at >= ?');
            values.push(filter.from);
        }
        if (filter.to !== undefined) {
            clauses.push('completed_at <= ?');
            values.push(filter.to);
        }
        values.push(filter.limit ?? 200);
        const rows = this.db
            .prepare(
                `SELECT json FROM session_evaluations
                 ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
                 ORDER BY completed_at DESC LIMIT ?`,
            )
            .all(...values) as Array<{ json: string }>;
        return rows.flatMap((row) => {
            try {
                return [JSON.parse(row.json) as SessionEvaluationRecord];
            } catch {
                return [];
            }
        });
    }

    async get(rootGoalId: string): Promise<SessionEvaluationRecord | undefined> {
        const row = this.db
            .prepare('SELECT json FROM session_evaluations WHERE root_goal_id = ?')
            .get(rootGoalId) as { json: string } | undefined;
        if (row === undefined) return undefined;
        try {
            return JSON.parse(row.json) as SessionEvaluationRecord;
        } catch {
            return undefined;
        }
    }

    async save(record: SessionEvaluationRecord): Promise<void> {
        this.db
            .prepare(
                `INSERT OR REPLACE INTO session_evaluations
                 (evaluation_id, root_goal_id, source, project_id, status, success,
                  started_at, completed_at, json)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                record.evaluationId,
                record.rootGoalId,
                record.source,
                record.projectId ?? null,
                record.status,
                record.success ? 1 : 0,
                record.startedAt,
                record.completedAt,
                JSON.stringify(record),
            );
    }

    close(): void {
        this.db.close();
    }
}
