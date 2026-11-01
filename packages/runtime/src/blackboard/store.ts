import { DatabaseSync } from 'node:sqlite';
import type { ProjectBlackboard } from './types.js';

export interface BlackboardStore {
    load(projectId: string): Promise<ProjectBlackboard | undefined>;
    save(board: ProjectBlackboard): Promise<void>;
    close(): void;
}

export class MemoryBlackboardStore implements BlackboardStore {
    private readonly boards = new Map<string, ProjectBlackboard>();

    async load(projectId: string): Promise<ProjectBlackboard | undefined> {
        return structuredClone(this.boards.get(projectId));
    }

    async save(board: ProjectBlackboard): Promise<void> {
        this.boards.set(board.projectId, structuredClone(board));
    }

    close(): void {}
}

export class SqliteBlackboardStore implements BlackboardStore {
    private readonly db: DatabaseSync;

    constructor(dbPath: string) {
        this.db = new DatabaseSync(dbPath);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS project_blackboards (
                project_id TEXT PRIMARY KEY,
                version INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_project_blackboards_updated
                ON project_blackboards(updated_at);
        `);
    }

    async load(projectId: string): Promise<ProjectBlackboard | undefined> {
        const row = this.db
            .prepare('SELECT json FROM project_blackboards WHERE project_id = ?')
            .get(projectId) as { json: string } | undefined;
        return row === undefined ? undefined : (JSON.parse(row.json) as ProjectBlackboard);
    }

    async save(board: ProjectBlackboard): Promise<void> {
        this.db
            .prepare(
                `INSERT OR REPLACE INTO project_blackboards
                 (project_id, version, updated_at, json) VALUES (?, ?, ?, ?)`,
            )
            .run(board.projectId, board.version, board.updatedAt, JSON.stringify(board));
    }

    close(): void {
        this.db.close();
    }
}
