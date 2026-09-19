/**
 * behavior-store —— 用户行为指令的 append-only 持久化端口与实现。
 *
 * 与 Goal/Task/Step 坐标存储分离：行为流是跨运行可携带的用户资产，
 * 只追加、不改写（见 docs/用户行为流设计文档.md §4/§10）。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { UserBehaviorRef, UserBehaviorType, UserBehaviorView } from '@mazi/libs';

/** 一条待写入的用户行为指令（ts 缺省由存储按单调守卫分配）。 */
export interface BehaviorRecordInput {
    type: UserBehaviorType;
    ref?: UserBehaviorRef;
    data: Record<string, unknown>;
    /** 期望时间戳（证据/关联时刻）；存储保证结果 >= lastTs + 1。 */
    ts?: number;
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
