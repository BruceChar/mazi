import { DatabaseSync } from 'node:sqlite';
import type { ULID } from '@mazi/core';
import type { DelegationEdge } from './delegation-types.js';

export interface DelegationStore {
    save(edge: DelegationEdge): Promise<void>;
    listByRoot(rootGoalId: string): Promise<DelegationEdge[]>;
    listByParent(parentGoalId: string): Promise<DelegationEdge[]>;
    deleteByRoot(rootGoalId: string): Promise<void>;
    close(): void;
}

export class MemoryDelegationStore implements DelegationStore {
    private readonly edges = new Map<string, DelegationEdge>();

    async save(edge: DelegationEdge): Promise<void> {
        this.edges.set(edge.edgeId, structuredClone(edge));
    }

    async listByRoot(rootGoalId: string): Promise<DelegationEdge[]> {
        return [...this.edges.values()]
            .filter((edge) => edge.rootGoalId === rootGoalId)
            .map((edge) => structuredClone(edge));
    }

    async listByParent(parentGoalId: string): Promise<DelegationEdge[]> {
        return [...this.edges.values()]
            .filter((edge) => edge.parentGoalId === parentGoalId)
            .map((edge) => structuredClone(edge));
    }

    async deleteByRoot(rootGoalId: string): Promise<void> {
        for (const [id, edge] of this.edges) {
            if (edge.rootGoalId === rootGoalId) this.edges.delete(id);
        }
    }

    close(): void {}
}

export class SqliteDelegationStore implements DelegationStore {
    private readonly db: DatabaseSync;

    constructor(dbPath: string) {
        this.db = new DatabaseSync(dbPath);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS delegation_edges (
                edge_id TEXT PRIMARY KEY,
                root_goal_id TEXT NOT NULL,
                parent_goal_id TEXT NOT NULL,
                child_goal_id TEXT NOT NULL UNIQUE,
                role_id TEXT NOT NULL,
                mode TEXT NOT NULL,
                permission_ceiling TEXT NOT NULL,
                budget_share TEXT NOT NULL,
                caused_by TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_delegation_edges_root
                ON delegation_edges(root_goal_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_delegation_edges_parent
                ON delegation_edges(parent_goal_id);
        `);
    }

    async save(edge: DelegationEdge): Promise<void> {
        this.db
            .prepare(
                `INSERT OR REPLACE INTO delegation_edges
                 (edge_id, root_goal_id, parent_goal_id, child_goal_id, role_id, mode,
                  permission_ceiling, budget_share, caused_by, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                edge.edgeId,
                edge.rootGoalId,
                edge.parentGoalId,
                edge.childGoalId,
                edge.roleId,
                edge.mode,
                edge.permissionCeiling,
                JSON.stringify(edge.budgetShare),
                edge.causedBy,
                edge.createdAt,
            );
    }

    async listByRoot(rootGoalId: string): Promise<DelegationEdge[]> {
        return this.query('SELECT * FROM delegation_edges WHERE root_goal_id = ?', rootGoalId);
    }

    async listByParent(parentGoalId: string): Promise<DelegationEdge[]> {
        return this.query('SELECT * FROM delegation_edges WHERE parent_goal_id = ?', parentGoalId);
    }

    async deleteByRoot(rootGoalId: string): Promise<void> {
        this.db.prepare('DELETE FROM delegation_edges WHERE root_goal_id = ?').run(rootGoalId);
    }

    close(): void {
        this.db.close();
    }

    private query(sql: string, id: string): DelegationEdge[] {
        const rows = this.db.prepare(sql).all(id) as Array<Record<string, unknown>>;
        return rows.map((row) => ({
            edgeId: String(row.edge_id),
            rootGoalId: String(row.root_goal_id) as ULID,
            parentGoalId: String(row.parent_goal_id) as ULID,
            childGoalId: String(row.child_goal_id) as ULID,
            roleId: String(row.role_id),
            mode: row.mode === 'rule' ? 'rule' : 'model',
            permissionCeiling: String(
                row.permission_ceiling,
            ) as DelegationEdge['permissionCeiling'],
            budgetShare: JSON.parse(String(row.budget_share)) as DelegationEdge['budgetShare'],
            causedBy: String(row.caused_by),
            createdAt: Number(row.created_at),
        }));
    }
}
