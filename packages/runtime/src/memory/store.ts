/**
 * memory/store.ts —— 记忆持久化端口（store 侧）。
 *
 * store 只负责与数据库 / 文件 / 向量库等存储实体交互，不理解上下文预算，也不决定
 * 该注入什么；记忆的调度策略由 memory.ts 承担。
 */

import { DatabaseSync } from 'node:sqlite';

export type MemoryKind = 'turn' | 'summary' | 'fact' | 'preference' | (string & {});
export type MemoryStatus = 'active' | 'deprecated' | 'tombstoned';

export interface MemoryProvenance {
    source:
        | 'user'
        | 'user_explicit'
        | 'user_confirmed'
        | 'system'
        | 'tool'
        | 'model'
        | 'model_inferred';
    ref?: string;
    confidence?: 'confirmed' | 'inferred' | 'pending_confirmation';
    trustTier?: 'T0' | 'T1' | 'T2' | 'T3';
}

export interface MemoryLinks {
    projectIds?: readonly string[];
    topicIds?: readonly string[];
    sessionIds?: readonly string[];
    taskIds?: readonly string[];
    entityIds?: readonly string[];
}

/** 一条长期记忆的最小形态（与具体存储解耦）。 */
export interface MemoryItem {
    id: string;
    kind: MemoryKind;
    text: string;
    /** kind='turn' 时的会话角色。 */
    role?: 'user' | 'assistant';
    createdAt: number;
    rootGoalId?: string;
    conversationId?: string;
    userId?: string;
    workspaceId?: string;
    projectId?: string;
    tags?: readonly string[];
    provenance?: MemoryProvenance;
    expiresAt?: number;
    status?: MemoryStatus;
    importance?: number;
    contentHash?: string;
    version?: number;
    supersedes?: readonly string[];
    contradicts?: readonly string[];
    links?: MemoryLinks;
}

export interface MemoryQuery {
    rootGoalId?: string;
    conversationId?: string;
    userId?: string;
    workspaceId?: string;
    projectId?: string;
    tags?: readonly string[];
    status?: MemoryStatus | 'all';
    /** Retrieval query text; stores ignore it and policies use it for ranking. */
    queryText?: string;
    /** Also used by MemoryManager to union scoped recall queries. */
    unionScope?: boolean;
    /** 召回条数上限；token 预算由 memory 策略处理。 */
    limit?: number;
}

/** 记忆持久化端口：SQLite / JSON / 向量库等实现。 */
export interface MemoryStore {
    append(items: readonly MemoryItem[]): Promise<void>;
    recall(query: MemoryQuery): Promise<readonly MemoryItem[]>;
    clear(query: MemoryQuery): Promise<void>;
    all(): Promise<readonly MemoryItem[]>;
    close(): void;
}

function matches(item: MemoryItem, query: MemoryQuery, now = Date.now()): boolean {
    if (query.status !== 'all' && (item.status ?? 'active') !== (query.status ?? 'active')) {
        return false;
    }
    if (item.expiresAt !== undefined && item.expiresAt <= now) return false;
    if (query.rootGoalId !== undefined && item.rootGoalId !== query.rootGoalId) return false;
    if (query.conversationId !== undefined && item.conversationId !== query.conversationId) {
        return false;
    }
    if (query.userId !== undefined && item.userId !== query.userId) return false;
    if (query.workspaceId !== undefined && item.workspaceId !== query.workspaceId) return false;
    if (query.projectId !== undefined && item.projectId !== query.projectId) return false;
    if (query.tags !== undefined) {
        const itemTags = new Set(item.tags ?? []);
        if (!query.tags.every((tag) => itemTags.has(tag))) return false;
    }
    return true;
}

/** 进程内实现（测试 / 轻量运行）；不跨进程持久化。 */
export class InMemoryMemoryStore implements MemoryStore {
    private readonly items = new Map<string, MemoryItem>();

    async append(items: readonly MemoryItem[]): Promise<void> {
        for (const item of items) this.items.set(item.id, structuredClone(item));
    }

    async recall(query: MemoryQuery): Promise<readonly MemoryItem[]> {
        return [...this.items.values()]
            .filter((item) => matches(item, query))
            .sort((a, b) => a.createdAt - b.createdAt)
            .map((item) => structuredClone(item));
    }

    async clear(query: MemoryQuery): Promise<void> {
        for (const [id, item] of [...this.items]) {
            if (matches(item, query)) this.items.delete(id);
        }
    }

    async all(): Promise<readonly MemoryItem[]> {
        return [...this.items.values()]
            .sort((a, b) => a.createdAt - b.createdAt)
            .map((item) => structuredClone(item));
    }

    close(): void {}
}

type MemoryRow = { json: string };

/** Durable local memory store. Indexes keep scope retrieval cheap; query filtering
 * remains in the shared matcher so every implementation has identical semantics. */
export class SqliteMemoryStore implements MemoryStore {
    private readonly db: DatabaseSync;
    private readonly now: () => number;

    constructor(dbPath: string, now: () => number = Date.now) {
        this.db = new DatabaseSync(dbPath);
        this.now = now;
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS memory_items (
                id TEXT PRIMARY KEY,
                root_goal_id TEXT,
                conversation_id TEXT,
                user_id TEXT,
                workspace_id TEXT,
                project_id TEXT,
                status TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                expires_at INTEGER,
                json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_memory_items_user
                ON memory_items(user_id, status, created_at);
            CREATE INDEX IF NOT EXISTS idx_memory_items_workspace
                ON memory_items(workspace_id, status, created_at);
            CREATE INDEX IF NOT EXISTS idx_memory_items_project
                ON memory_items(project_id, status, created_at);
            CREATE INDEX IF NOT EXISTS idx_memory_items_conversation
                ON memory_items(conversation_id, status, created_at);
            CREATE INDEX IF NOT EXISTS idx_memory_items_root
                ON memory_items(root_goal_id, status, created_at);
        `);
    }

    async append(items: readonly MemoryItem[]): Promise<void> {
        const statement = this.db.prepare(
            `INSERT OR REPLACE INTO memory_items
             (id, root_goal_id, conversation_id, user_id, workspace_id, project_id,
              status, created_at, expires_at, json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const item of items) {
            statement.run(
                item.id,
                item.rootGoalId ?? null,
                item.conversationId ?? null,
                item.userId ?? null,
                item.workspaceId ?? null,
                item.projectId ?? null,
                item.status ?? 'active',
                item.createdAt,
                item.expiresAt ?? null,
                JSON.stringify(item),
            );
        }
    }

    async recall(query: MemoryQuery): Promise<readonly MemoryItem[]> {
        const rows = this.db.prepare('SELECT json FROM memory_items').all() as MemoryRow[];
        return rows
            .map((row) => JSON.parse(row.json) as MemoryItem)
            .filter((item) => matches(item, query, this.now()))
            .sort((a, b) => a.createdAt - b.createdAt)
            .slice(-(query.limit ?? Number.MAX_SAFE_INTEGER));
    }

    async clear(query: MemoryQuery): Promise<void> {
        const rows = this.db.prepare('SELECT id, json FROM memory_items').all() as Array<{
            id: string;
            json: string;
        }>;
        const statement = this.db.prepare('DELETE FROM memory_items WHERE id = ?');
        for (const row of rows) {
            if (matches(JSON.parse(row.json) as MemoryItem, query, this.now())) {
                statement.run(row.id);
            }
        }
    }

    async all(): Promise<readonly MemoryItem[]> {
        const rows = this.db
            .prepare('SELECT json FROM memory_items ORDER BY created_at ASC')
            .all() as MemoryRow[];
        return rows.map((row) => JSON.parse(row.json) as MemoryItem);
    }

    close(): void {
        this.db.close();
    }
}
