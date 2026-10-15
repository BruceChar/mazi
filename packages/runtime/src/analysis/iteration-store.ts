/**
 * iteration-store —— 系统迭代记录的存储（同 toc_* 模式：node:sqlite + JSON 列）。
 *
 * 表 iteration_records 只放主键/索引列 + json 全量视图；analyze/status 冗余成列仅为过滤与索引，
 * 版本快照由 API 层注入（runtime 不读 git，保持运行时与 VCS 解耦）。
 */

import { DatabaseSync } from 'node:sqlite';
import type { IterationRecordView } from '@mazi/libs';

export interface IterationStore {
    save(record: IterationRecordView): Promise<void>;
    load(iterationId: string): Promise<IterationRecordView | undefined>;
    list(): Promise<IterationRecordView[]>;
    listByAnalyze(analyzeId: string): Promise<IterationRecordView[]>;
    close(): void;
}

type Row = Record<string, unknown>;

function toJson(value: unknown): string | null {
    return value === undefined ? null : JSON.stringify(value);
}

function fromJson<T>(raw: unknown): T | undefined {
    return typeof raw === 'string' ? (JSON.parse(raw) as T) : undefined;
}

/** 两个实现共用同一排序口径（面板按最近改动倒序）。 */
function byUpdatedAtDesc(records: IterationRecordView[]): IterationRecordView[] {
    return records.slice().sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 内存实现（测试） */
export class MemoryIterationStore implements IterationStore {
    private readonly records = new Map<string, IterationRecordView>();

    async save(record: IterationRecordView): Promise<void> {
        this.records.set(record.iterationId, structuredClone(record));
    }
    async load(iterationId: string): Promise<IterationRecordView | undefined> {
        return structuredClone(this.records.get(iterationId));
    }
    async list(): Promise<IterationRecordView[]> {
        return byUpdatedAtDesc([...this.records.values()].map((record) => structuredClone(record)));
    }
    async listByAnalyze(analyzeId: string): Promise<IterationRecordView[]> {
        return byUpdatedAtDesc(
            [...this.records.values()]
                .filter((record) => record.analyzeId === analyzeId)
                .map((record) => structuredClone(record)),
        );
    }
    close(): void {
        this.records.clear();
    }
}

function createIterationTables(db: DatabaseSync): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS iteration_records (
            iteration_id TEXT PRIMARY KEY,
            analyze_id TEXT,
            status TEXT,
            json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_iteration_records_analyze ON iteration_records(analyze_id);
        CREATE INDEX IF NOT EXISTS idx_iteration_records_status ON iteration_records(status);
    `);
}

/** node:sqlite 落地实现（独立连接；表结构懒建） */
export class SqliteIterationStore implements IterationStore {
    private readonly db: DatabaseSync;

    constructor(dbPath: string) {
        this.db = new DatabaseSync(dbPath);
        this.db.exec('PRAGMA busy_timeout = 5000;');
        createIterationTables(this.db);
    }

    async save(record: IterationRecordView): Promise<void> {
        this.db
            .prepare(
                'INSERT OR REPLACE INTO iteration_records (iteration_id, analyze_id, status, json) VALUES (?, ?, ?, ?)',
            )
            .run(record.iterationId, record.analyzeId ?? null, record.status, toJson(record));
    }
    async load(iterationId: string): Promise<IterationRecordView | undefined> {
        const row = this.db
            .prepare('SELECT json FROM iteration_records WHERE iteration_id = ?')
            .get(iterationId) as Row | undefined;
        return row ? fromJson<IterationRecordView>(row.json) : undefined;
    }
    async list(): Promise<IterationRecordView[]> {
        const rows = this.db.prepare('SELECT json FROM iteration_records').all() as Row[];
        return byUpdatedAtDesc(
            rows
                .map((row) => fromJson<IterationRecordView>(row.json))
                .filter((r): r is IterationRecordView => !!r),
        );
    }
    async listByAnalyze(analyzeId: string): Promise<IterationRecordView[]> {
        const rows = this.db
            .prepare('SELECT json FROM iteration_records WHERE analyze_id = ?')
            .all(analyzeId) as Row[];
        return byUpdatedAtDesc(
            rows
                .map((row) => fromJson<IterationRecordView>(row.json))
                .filter((r): r is IterationRecordView => !!r),
        );
    }
    close(): void {
        this.db.close();
    }
}
