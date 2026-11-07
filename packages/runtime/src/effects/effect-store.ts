/**
 * Reversible workspace effects.
 *
 * Only files the tool explicitly declares can be restored automatically. A
 * shell command or remote write is not magically reversible; those remain
 * irreversible and must be protected by approval.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ulid } from '@mazi/core';

export type EffectStatus = 'applied' | 'rolled-back' | 'rollback-failed';

export interface FileSnapshot {
    path: string;
    existed: boolean;
    contentBase64?: string;
    hash: string;
}

export interface EffectRecord {
    effectId: string;
    rootGoalId: string;
    goalId: string;
    taskId: string;
    stepId: string;
    toolName: string;
    argsDigest: string;
    before: FileSnapshot[];
    reversible: boolean;
    status: EffectStatus;
    createdAt: number;
    rolledBackAt?: number;
    error?: string;
}

export interface EffectStore {
    append(record: EffectRecord): Promise<void>;
    list(rootGoalId: string, status?: EffectStatus): Promise<EffectRecord[]>;
    update(record: EffectRecord): Promise<void>;
    close(): void;
}

export class MemoryEffectStore implements EffectStore {
    private readonly records = new Map<string, EffectRecord>();

    async append(record: EffectRecord): Promise<void> {
        this.records.set(record.effectId, structuredClone(record));
    }

    async list(rootGoalId: string, status?: EffectStatus): Promise<EffectRecord[]> {
        return [...this.records.values()]
            .filter(
                (record) =>
                    record.rootGoalId === rootGoalId &&
                    (status === undefined || record.status === status),
            )
            .sort((a, b) => b.createdAt - a.createdAt)
            .map((record) => structuredClone(record));
    }

    async update(record: EffectRecord): Promise<void> {
        this.records.set(record.effectId, structuredClone(record));
    }

    close(): void {}
}

export class SqliteEffectStore implements EffectStore {
    private readonly db: DatabaseSync;

    constructor(dbPath: string) {
        this.db = new DatabaseSync(dbPath);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS effect_journal (
                effect_id TEXT PRIMARY KEY,
                root_goal_id TEXT NOT NULL,
                status TEXT NOT NULL,
                json TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_effect_journal_root
                ON effect_journal(root_goal_id, status, created_at);
        `);
    }

    async append(record: EffectRecord): Promise<void> {
        this.db
            .prepare(
                `INSERT OR REPLACE INTO effect_journal
                 (effect_id, root_goal_id, status, json, created_at)
                 VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
                record.effectId,
                record.rootGoalId,
                record.status,
                JSON.stringify(record),
                record.createdAt,
            );
    }

    async list(rootGoalId: string, status?: EffectStatus): Promise<EffectRecord[]> {
        const rows = (
            status === undefined
                ? this.db
                      .prepare(
                          `SELECT json FROM effect_journal
                           WHERE root_goal_id = ? ORDER BY created_at DESC`,
                      )
                      .all(rootGoalId)
                : this.db
                      .prepare(
                          `SELECT json FROM effect_journal
                           WHERE root_goal_id = ? AND status = ?
                           ORDER BY created_at DESC`,
                      )
                      .all(rootGoalId, status)
        ) as Array<{ json: string }>;
        return rows.map((row) => JSON.parse(row.json) as EffectRecord);
    }

    async update(record: EffectRecord): Promise<void> {
        await this.append(record);
    }

    close(): void {
        this.db.close();
    }
}

function safeWorkspacePath(workspaceRoot: string, path: string): string {
    const root = resolve(workspaceRoot);
    const target = resolve(isAbsolute(path) ? path : resolve(root, path));
    const rel = relative(root, target);
    if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(`回滚路径越出工作区：${path}`);
    }
    return target;
}

export function effectPathsForTool(
    tool: { name: string; sideEffects: readonly string[] },
    args: Record<string, unknown>,
): string[] {
    if (tool.name === 'fs.read') return [];
    if (!tool.sideEffects.includes('fs')) return [];
    if (tool.name === 'git' || tool.name === 'shell.run') return [];
    return typeof args.path === 'string' && args.path.length > 0 ? [args.path] : [];
}

export function snapshotFiles(workspaceRoot: string, paths: readonly string[]): FileSnapshot[] {
    return paths.map((path) => {
        const absolute = safeWorkspacePath(workspaceRoot, path);
        if (!existsSync(absolute)) {
            return {
                path,
                existed: false,
                hash: createHash('sha256').update('').digest('hex'),
            };
        }
        const content = readFileSync(absolute);
        return {
            path,
            existed: true,
            contentBase64: content.toString('base64'),
            hash: createHash('sha256').update(content).digest('hex'),
        };
    });
}

export function argsDigest(args: Record<string, unknown>): string {
    return createHash('sha256').update(JSON.stringify(args)).digest('hex');
}

export function newEffectRecord(input: {
    rootGoalId: string;
    goalId: string;
    taskId: string;
    stepId: string;
    toolName: string;
    args: Record<string, unknown>;
    before: FileSnapshot[];
    now?: number;
}): EffectRecord {
    return {
        effectId: ulid(),
        rootGoalId: input.rootGoalId,
        goalId: input.goalId,
        taskId: input.taskId,
        stepId: input.stepId,
        toolName: input.toolName,
        argsDigest: argsDigest(input.args),
        before: input.before,
        reversible: input.before.length > 0,
        status: 'applied',
        createdAt: input.now ?? Date.now(),
    };
}

export async function rollbackEffects(
    store: EffectStore,
    rootGoalId: string,
    workspaceRoot: string,
    now: () => number = Date.now,
): Promise<EffectRecord[]> {
    const records = await store.list(rootGoalId, 'applied');
    const changed: EffectRecord[] = [];
    for (const record of records) {
        try {
            for (const snapshot of [...record.before].reverse()) {
                const absolute = safeWorkspacePath(workspaceRoot, snapshot.path);
                if (!snapshot.existed) {
                    if (existsSync(absolute)) unlinkSync(absolute);
                    continue;
                }
                mkdirSync(dirname(absolute), { recursive: true });
                writeFileSync(absolute, Buffer.from(snapshot.contentBase64 ?? '', 'base64'));
            }
            record.status = 'rolled-back';
            record.rolledBackAt = now();
            delete record.error;
        } catch (error) {
            record.status = 'rollback-failed';
            record.error = error instanceof Error ? error.message : String(error);
        }
        await store.update(record);
        changed.push(record);
    }
    return changed;
}
