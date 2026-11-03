import { DatabaseSync } from 'node:sqlite';
import type { EvalReport } from './types.js';

export type EvalRunStatus = 'running' | 'completed' | 'failed';

export interface EvalRunRecord {
    runId: string;
    status: EvalRunStatus;
    taskIds: string[];
    startedAt: number;
    completedAt?: number;
    modelId?: string;
    promptPackId?: string;
    workspace?: string;
    report?: EvalReport;
    error?: string;
}

export interface EvalRunStore {
    list(limit?: number): Promise<EvalRunRecord[]>;
    get(runId: string): Promise<EvalRunRecord | undefined>;
    save(run: EvalRunRecord): Promise<void>;
    close(): void;
}

export class MemoryEvalRunStore implements EvalRunStore {
    private readonly runs = new Map<string, EvalRunRecord>();

    async list(limit = 100): Promise<EvalRunRecord[]> {
        return [...this.runs.values()]
            .sort((left, right) => right.startedAt - left.startedAt)
            .slice(0, limit)
            .map((run) => structuredClone(run));
    }

    async get(runId: string): Promise<EvalRunRecord | undefined> {
        return structuredClone(this.runs.get(runId));
    }

    async save(run: EvalRunRecord): Promise<void> {
        this.runs.set(run.runId, structuredClone(run));
    }

    close(): void {}
}

export class SqliteEvalRunStore implements EvalRunStore {
    private readonly db: DatabaseSync;

    constructor(dbPath: string) {
        this.db = new DatabaseSync(dbPath);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS eval_runs (
                run_id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                started_at INTEGER NOT NULL,
                completed_at INTEGER,
                json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_eval_runs_started
                ON eval_runs(started_at DESC);
        `);
    }

    async list(limit = 100): Promise<EvalRunRecord[]> {
        const rows = this.db
            .prepare('SELECT json FROM eval_runs ORDER BY started_at DESC LIMIT ?')
            .all(limit) as Array<{ json: string }>;
        return rows.flatMap((row) => {
            try {
                return [JSON.parse(row.json) as EvalRunRecord];
            } catch {
                return [];
            }
        });
    }

    async get(runId: string): Promise<EvalRunRecord | undefined> {
        const row = this.db.prepare('SELECT json FROM eval_runs WHERE run_id = ?').get(runId) as
            | { json: string }
            | undefined;
        if (row === undefined) return undefined;
        try {
            return JSON.parse(row.json) as EvalRunRecord;
        } catch {
            return undefined;
        }
    }

    async save(run: EvalRunRecord): Promise<void> {
        this.db
            .prepare(
                `INSERT OR REPLACE INTO eval_runs
                 (run_id, status, started_at, completed_at, json) VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
                run.runId,
                run.status,
                run.startedAt,
                run.completedAt ?? null,
                JSON.stringify(run),
            );
    }

    close(): void {
        this.db.close();
    }
}
