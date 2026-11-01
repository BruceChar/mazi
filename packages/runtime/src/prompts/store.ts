import { DatabaseSync } from 'node:sqlite';
import type { PromptPack, PromptPackStore } from './types.js';

export class MemoryPromptPackStore implements PromptPackStore {
    private readonly packs = new Map<string, PromptPack>();

    load(): PromptPack[] {
        return [...this.packs.values()].map((pack) => structuredClone(pack));
    }

    save(pack: PromptPack): void {
        this.packs.set(pack.id, structuredClone(pack));
    }

    close(): void {}
}

export class SqlitePromptPackStore implements PromptPackStore {
    private readonly db: DatabaseSync;

    constructor(dbPath: string) {
        this.db = new DatabaseSync(dbPath);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS prompt_packs (
                id TEXT PRIMARY KEY,
                version INTEGER NOT NULL,
                enabled INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_prompt_packs_updated
                ON prompt_packs(updated_at);
        `);
    }

    load(): PromptPack[] {
        const rows = this.db.prepare('SELECT json FROM prompt_packs ORDER BY id').all() as Array<{
            json: string;
        }>;
        const packs: PromptPack[] = [];
        for (const row of rows) {
            try {
                packs.push(JSON.parse(row.json) as PromptPack);
            } catch {
                // A damaged row must not prevent the remaining registry from loading.
            }
        }
        return packs;
    }

    save(pack: PromptPack): void {
        this.db
            .prepare(
                `INSERT OR REPLACE INTO prompt_packs
                 (id, version, enabled, updated_at, json) VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
                pack.id,
                pack.version,
                pack.enabled === false ? 0 : 1,
                Date.now(),
                JSON.stringify(pack),
            );
    }

    close(): void {
        this.db.close();
    }
}
