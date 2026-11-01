import { DatabaseSync } from 'node:sqlite';
import type { AgentRole } from './delegation-types.js';

export interface PersistedAgentRole {
    role: AgentRole;
    deleted: boolean;
}

export interface AgentRoleStore {
    load(): PersistedAgentRole[];
    save(entry: PersistedAgentRole): void;
    close(): void;
}

export class MemoryAgentRoleStore implements AgentRoleStore {
    private readonly roles = new Map<string, PersistedAgentRole>();

    load(): PersistedAgentRole[] {
        return [...this.roles.values()].map((entry) => structuredClone(entry));
    }

    save(entry: PersistedAgentRole): void {
        this.roles.set(entry.role.roleId, structuredClone(entry));
    }

    close(): void {}
}

export class SqliteAgentRoleStore implements AgentRoleStore {
    private readonly db: DatabaseSync;

    constructor(dbPath: string) {
        this.db = new DatabaseSync(dbPath);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS agent_roles (
                role_id TEXT PRIMARY KEY,
                label TEXT NOT NULL,
                deleted INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_agent_roles_updated
                ON agent_roles(updated_at);
        `);
    }

    load(): PersistedAgentRole[] {
        const rows = this.db
            .prepare('SELECT json FROM agent_roles ORDER BY role_id')
            .all() as Array<{ json: string }>;
        const roles: PersistedAgentRole[] = [];
        for (const row of rows) {
            try {
                roles.push(JSON.parse(row.json) as PersistedAgentRole);
            } catch {
                // A damaged row must not prevent other roles from loading.
            }
        }
        return roles;
    }

    save(entry: PersistedAgentRole): void {
        this.db
            .prepare(
                `INSERT OR REPLACE INTO agent_roles
                 (role_id, label, deleted, updated_at, json) VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
                entry.role.roleId,
                entry.role.label,
                entry.deleted ? 1 : 0,
                Date.now(),
                JSON.stringify(entry),
            );
    }

    close(): void {
        this.db.close();
    }
}
