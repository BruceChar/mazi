/**
 * behavior-store —— 用户行为指令的 append-only 持久化端口与实现。
 *
 * 与 Goal/Task/Step 坐标存储分离：行为流是跨运行可携带的用户资产，
 * 只追加、不改写（见 docs/用户行为流设计文档.md §4/§10）。
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { UserBehaviorRef, UserBehaviorType, UserBehaviorView } from '@mazi/libs';
import { ensureQuestionTables } from './question-store.js';

/** 一条待写入的用户行为指令（ts 缺省由存储按单调守卫分配）。 */
export interface BehaviorRecordInput {
    type: UserBehaviorType;
    ref?: UserBehaviorRef;
    data: Record<string, unknown>;
    /** 期望时间戳（证据/关联时刻）；存储保证结果 >= lastTs + 1。 */
    ts?: number;
    /** 归属用户（problem/questions 投影用；可选，best-effort）。 */
    userId?: string;
    /** 归属 Conversation（可选，best-effort）。 */
    conversationId?: string;
}

export interface BehaviorStore {
    /** 追加若干条行为指令，返回落库视图（含分配后的 ts）。 */
    append(
        rootGoalId: string,
        records: readonly BehaviorRecordInput[],
    ): Promise<UserBehaviorView[]>;
    list(rootGoalId: string): Promise<UserBehaviorView[]>;
    /** 级联删除（Conversation 删除用）。 */
    clear(rootGoalId: string): Promise<void>;
    close(): void;
}

const SCHEMA_VERSION = '2.0';

/** 单调守卫：ts = max(base, last + 1)，使「ts 即 id」永久成立（设计文档 §3）。 */
function nextTs(base: number, last: number): number {
    return Math.max(base, last + 1);
}

function toView(ts: number, input: BehaviorRecordInput): UserBehaviorView {
    return {
        ts,
        type: input.type,
        ...(input.ref !== undefined ? { ref: input.ref } : {}),
        data: input.data,
    };
}

/** 进程内实现（测试 / 轻量运行）。 */
export class MemoryBehaviorStore implements BehaviorStore {
    private readonly records = new Map<string, UserBehaviorView[]>();
    private readonly lastTs = new Map<string, number>();
    private readonly now: () => number;

    constructor(now: () => number = () => Date.now()) {
        this.now = now;
    }

    async append(
        rootGoalId: string,
        inputs: readonly BehaviorRecordInput[],
    ): Promise<UserBehaviorView[]> {
        const list = this.records.get(rootGoalId) ?? [];
        let last = this.lastTs.get(rootGoalId) ?? 0;
        const written: UserBehaviorView[] = [];
        for (const input of inputs) {
            const ts = nextTs(input.ts ?? this.now(), last);
            last = ts;
            const view = toView(ts, input);
            list.push(view);
            written.push(view);
        }
        this.records.set(rootGoalId, list);
        this.lastTs.set(rootGoalId, last);
        return written;
    }

    async list(rootGoalId: string): Promise<UserBehaviorView[]> {
        return (this.records.get(rootGoalId) ?? []).map((view) => structuredClone(view));
    }

    async clear(rootGoalId: string): Promise<void> {
        this.records.delete(rootGoalId);
        this.lastTs.delete(rootGoalId);
    }

    close(): void {}
}

function isBehaviorView(value: unknown): value is UserBehaviorView {
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Record<string, unknown>;
    return (
        typeof record.ts === 'number' &&
        typeof record.type === 'string' &&
        typeof record.data === 'object' &&
        record.data !== null
    );
}

/** 路径安全：rootGoalId 为 ULID，仍兜底替换非安全字符。 */
function sanitize(id: string): string {
    return id.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * JSONL 落盘实现：按运行会话分文件，文件头 + 逐行记录，append-only。
 * 进程内缓存已加载分区，支持同实例读后写与跨实例重载。
 */
export class JsonlBehaviorStore implements BehaviorStore {
    private readonly dir: string;
    private readonly now: () => number;
    private readonly cache = new Map<string, UserBehaviorView[]>();
    private readonly lastTs = new Map<string, number>();
    private readonly loaded = new Set<string>();

    constructor(dir: string, now: () => number = () => Date.now()) {
        this.dir = dir;
        this.now = now;
    }

    async append(
        rootGoalId: string,
        inputs: readonly BehaviorRecordInput[],
    ): Promise<UserBehaviorView[]> {
        this.ensureLoaded(rootGoalId);
        const list = this.cache.get(rootGoalId) ?? [];
        let last = this.lastTs.get(rootGoalId) ?? 0;
        const written: UserBehaviorView[] = [];
        const lines: string[] = [];
        if (!existsSync(this.filePath(rootGoalId))) {
            lines.push(
                JSON.stringify({
                    format: 'user-behavior-stream',
                    schemaVersion: SCHEMA_VERSION,
                    rootGoalId,
                }),
            );
        }
        for (const input of inputs) {
            const ts = nextTs(input.ts ?? this.now(), last);
            last = ts;
            const view = toView(ts, input);
            list.push(view);
            written.push(view);
            lines.push(JSON.stringify(view));
        }
        mkdirSync(this.dir, { recursive: true });
        appendFileSync(this.filePath(rootGoalId), lines.join('\n') + '\n', 'utf8');
        this.cache.set(rootGoalId, list);
        this.lastTs.set(rootGoalId, last);
        return written;
    }

    async list(rootGoalId: string): Promise<UserBehaviorView[]> {
        this.ensureLoaded(rootGoalId);
        return (this.cache.get(rootGoalId) ?? []).map((view) => structuredClone(view));
    }

    async clear(rootGoalId: string): Promise<void> {
        rmSync(this.filePath(rootGoalId), { force: true });
        this.cache.delete(rootGoalId);
        this.lastTs.delete(rootGoalId);
        this.loaded.delete(rootGoalId);
    }

    close(): void {}

    /** 文件路径（append-only：只读加载与追加，永不重写历史行）。 */
    filePath(rootGoalId: string): string {
        return join(this.dir, sanitize(rootGoalId) + '.jsonl');
    }

    /** 列出已有分区（rootGoalId）——迁移/导出用。 */
    partitions(): string[] {
        try {
            return readdirSync(this.dir)
                .filter((name) => name.endsWith('.jsonl'))
                .map((name) => name.slice(0, -'.jsonl'.length));
        } catch {
            return [];
        }
    }

    private ensureLoaded(rootGoalId: string): void {
        if (this.loaded.has(rootGoalId)) return;
        this.loaded.add(rootGoalId);
        if (!existsSync(this.filePath(rootGoalId))) return;
        const raw = readFileSync(this.filePath(rootGoalId), 'utf8');
        const list: UserBehaviorView[] = [];
        let last = 0;
        for (const line of raw.split('\n')) {
            if (line.trim().length === 0) continue;
            let parsed: unknown;
            try {
                parsed = JSON.parse(line);
            } catch {
                continue;
            }
            if (!isBehaviorView(parsed)) continue;
            list.push(parsed);
            last = Math.max(last, parsed.ts);
        }
        this.cache.set(rootGoalId, list);
        this.lastTs.set(rootGoalId, last);
    }
}

/** SQLite 落地实现：行为流**权威库**（append-only；ts 分区内单调）。 */
export class SqliteBehaviorStore implements BehaviorStore {
    private readonly db: DatabaseSync;
    private readonly now: () => number;
    private readonly lastTs = new Map<string, number>();

    constructor(dbPath: string, now: () => number = () => Date.now()) {
        this.db = new DatabaseSync(dbPath);
        this.now = now;
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS user_behaviors (
                behavior_id TEXT PRIMARY KEY,
                ts INTEGER NOT NULL,
                user_id TEXT,
                session_id TEXT NOT NULL,
                conversation_id TEXT,
                type TEXT NOT NULL,
                ref_ts INTEGER,
                ref_json TEXT,
                data TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_user_behaviors_session ON user_behaviors(session_id, ts);
            CREATE INDEX IF NOT EXISTS idx_user_behaviors_user ON user_behaviors(user_id, ts);
        `);
        ensureQuestionTables(this.db);
    }

    async append(
        rootGoalId: string,
        inputs: readonly BehaviorRecordInput[],
    ): Promise<UserBehaviorView[]> {
        let last = this.lastTs.get(rootGoalId) ?? this.maxTs(rootGoalId);
        const written: UserBehaviorView[] = [];
        const insert = this.db.prepare(
            'INSERT OR REPLACE INTO user_behaviors (behavior_id, ts, user_id, session_id, conversation_id, type, ref_ts, ref_json, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        );
        for (const input of inputs) {
            const ts = nextTs(input.ts ?? this.now(), last);
            last = ts;
            insert.run(
                // 确定性主键 = 分区 + ts（「ts 即 id」），使重复导入幂等。
                rootGoalId + ':' + ts,
                ts,
                input.userId ?? null,
                rootGoalId,
                input.conversationId ?? null,
                input.type,
                input.ref?.ts ?? null,
                input.ref !== undefined ? JSON.stringify(input.ref) : null,
                JSON.stringify(input.data),
                Date.now(),
            );
            if (input.type === 'input') {
                this.projectQuestion(rootGoalId, ts, input);
            }
            written.push(toView(ts, input));
        }
        this.lastTs.set(rootGoalId, last);
        return written;
    }

    async list(rootGoalId: string): Promise<UserBehaviorView[]> {
        const rows = this.db
            .prepare(
                'SELECT ts, type, ref_json, data FROM user_behaviors WHERE session_id = ? ORDER BY ts ASC',
            )
            .all(rootGoalId) as Array<{
            ts: number;
            type: string;
            ref_json: string | null;
            data: string;
        }>;
        return rows.map((row) => ({
            ts: row.ts,
            type: row.type as UserBehaviorView['type'],
            ...(row.ref_json !== null ? { ref: JSON.parse(row.ref_json) as UserBehaviorRef } : {}),
            data: JSON.parse(row.data) as Record<string, unknown>,
        }));
    }

    async clear(rootGoalId: string): Promise<void> {
        this.db
            .prepare(
                'DELETE FROM question_labels WHERE question_id IN (SELECT question_id FROM user_questions WHERE session_id = ?)',
            )
            .run(rootGoalId);
        this.db.prepare('DELETE FROM user_questions WHERE session_id = ?').run(rootGoalId);
        this.db.prepare('DELETE FROM user_behaviors WHERE session_id = ?').run(rootGoalId);
        this.lastTs.delete(rootGoalId);
    }

    /** input → user_questions 投影（问题实体；标签由 question-store 维护）。 */
    private projectQuestion(rootGoalId: string, ts: number, input: BehaviorRecordInput): void {
        const text = typeof input.data.text === 'string' ? input.data.text : '';
        const derived = input.data.derived === true ? 1 : 0;
        this.db
            .prepare(
                'INSERT OR REPLACE INTO user_questions (question_id, behavior_id, ts, user_id, session_id, conversation_id, text, derived, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            )
            .run(
                rootGoalId + ':' + ts,
                rootGoalId + ':' + ts,
                ts,
                input.userId ?? null,
                rootGoalId,
                input.conversationId ?? null,
                text,
                derived,
                Date.now(),
            );
    }

    close(): void {
        this.db.close();
    }

    private maxTs(rootGoalId: string): number {
        const row = this.db
            .prepare('SELECT MAX(ts) AS max_ts FROM user_behaviors WHERE session_id = ?')
            .get(rootGoalId) as { max_ts: number | null } | undefined;
        return row?.max_ts ?? 0;
    }
}

export interface BehaviorMigrationResult {
    /** 导入的分区数。 */
    partitions: number;
    /** 导入的记录数。 */
    imported: number;
}

/**
 * 一次性把旧的 JSONL 行为流导入目标（DB）store。已存在的分区跳过（幂等）；
 * JSONL 原文件不删除（保留为原始证据）。
 */
export async function migrateBehaviorJsonlToSqlite(
    behaviorDir: string,
    target: BehaviorStore,
): Promise<BehaviorMigrationResult> {
    const source = new JsonlBehaviorStore(behaviorDir);
    let partitions = 0;
    let imported = 0;
    for (const rootGoalId of source.partitions()) {
        const existing = await target.list(rootGoalId);
        if (existing.length > 0) continue;
        const records = await source.list(rootGoalId);
        if (records.length === 0) continue;
        await target.append(
            rootGoalId,
            records.map((view) => ({
                type: view.type,
                ts: view.ts,
                ...(view.ref !== undefined ? { ref: view.ref } : {}),
                data: view.data,
            })),
        );
        partitions += 1;
        imported += records.length;
    }
    source.close();
    return { partitions, imported };
}
