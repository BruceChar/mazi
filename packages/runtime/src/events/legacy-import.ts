/**
 * 历史 JSONL 一次性迁移（R5f）：只把权限审计本体与定位骨架迁入 SQLite 权威库，
 * 不迁移逐 token 流碎片与 step 重复全文。纯函数 + 扫描器，测试先行。
 *
 * 历史记录无 seq/prevHash/hash，入库后由 verifyChain 计入 legacy 跳过链式校验。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessEvent } from '@mazi/core';
import type { SqliteEventStore } from './sqlite-event-store.js';

/** 迁移白名单：权限类审计本体 + goal/turn/plan 定位骨架。 */
export const LEGACY_IMPORT_TYPES: readonly string[] = [
    'policy.check',
    'policy.denied',
    'approval.granted',
    'approval.requested',
    'approval.cancelled',
    'goal.started',
    'goal.ended',
    'turn.started',
    'turn.ended',
    'goal.phase',
    'plan.created',
];

/** 该类型是否属于迁移白名单。 */
export function isImportableLegacyType(type: unknown): boolean {
    return typeof type === 'string' && LEGACY_IMPORT_TYPES.includes(type);
}

/**
 * 把旧 JSONL 记录映射为 HarnessEvent：透传既有标识与 payload，不补 seq/hash。
 * 缺 eventId / rootGoalId / timestamp 或非对象时返回 undefined。
 */
export function mapLegacyEvent(record: unknown): HarnessEvent | undefined {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) return undefined;
    const rec = record as Record<string, unknown>;
    const { eventId, rootGoalId, timestamp, type } = rec;
    if (typeof eventId !== 'string' || eventId.length === 0) return undefined;
    if (typeof rootGoalId !== 'string' || rootGoalId.length === 0) return undefined;
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return undefined;
    if (!isImportableLegacyType(type)) return undefined;

    const optionalString = (
        key: 'sessionId' | 'goalId' | 'taskId' | 'stepId' | 'causedBy',
    ): { [k in typeof key]?: string } | Record<string, never> => {
        const value = rec[key];
        return typeof value === 'string' ? { [key]: value } : {};
    };
    const actor = typeof rec.actor === 'string' ? { actor: rec.actor } : {};

    return {
        type: type as HarnessEvent['type'],
        rootGoalId,
        eventId,
        timestamp,
        attributes: (rec.attributes as HarnessEvent['attributes']) ?? {},
        payload: rec.payload,
        ...optionalString('sessionId'),
        ...optionalString('goalId'),
        ...optionalString('taskId'),
        ...optionalString('stepId'),
        ...optionalString('causedBy'),
        ...actor,
    } as HarnessEvent;
}

/** 迁移统计。 */
export interface LegacyImportStats {
    /** 读取的非空行数 */
    scanned: number;
    /** 本次新写入条数 */
    imported: number;
    /** 重复 eventId（已见，主键兜底替换） */
    duplicates: number;
    /** 非白名单类型 / 坏行 / 缺必要字段 */
    skipped: number;
}

/**
 * 扫描 sourceDir 下平铺 *.jsonl，把白名单事件追加进 store（event_id 幂等）。
 * 不递归、不删除源文件；删除由调用方在校验通过后执行。
 */
export function importLegacyEvents(
    sourceDir: string,
    store: Pick<SqliteEventStore, 'append'>,
): LegacyImportStats {
    const stats: LegacyImportStats = { scanned: 0, imported: 0, duplicates: 0, skipped: 0 };
    let files: string[];
    try {
        files = readdirSync(sourceDir).filter((name) => name.endsWith('.jsonl'));
    } catch {
        return stats;
    }

    const seen = new Set<string>();
    for (const name of files) {
        const content = readFileSync(join(sourceDir, name), 'utf8');
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;
            stats.scanned += 1;

            let record: unknown;
            try {
                record = JSON.parse(trimmed);
            } catch {
                stats.skipped += 1;
                continue;
            }
            const mapped = mapLegacyEvent(record);
            if (mapped === undefined) {
                stats.skipped += 1;
                continue;
            }
            if (seen.has(mapped.eventId)) {
                stats.duplicates += 1;
                continue;
            }
            seen.add(mapped.eventId);
            store.append(mapped);
            stats.imported += 1;
        }
    }
    return stats;
}
