/**
 * 一次性历史事件迁移：legacy 词汇（sessionId / session.*）→ gts 契约（rootGoalId / goal.*）。
 *
 * 背景：observability 契约在 gts 词汇迁移后按 rootGoalId 落盘并按该字段回放；
 * 迁移前写入的 JSONL 使用 sessionId 顶层字段与 session.started/ended 类型，
 * 导致 replay(rootGoalId) 过滤后恒空。本脚本把磁盘上仍为 legacy 形状的事件
 * 转换为新契约格式（幂等：已含 rootGoalId 的行原样保留）。
 *
 * 用法：node --import tsx packages/runtime/scripts/migrate-legacy-events.ts
 * 迁移前将原始文件备份到 <home>/events.bak/（同名），安全起见不覆盖已有备份。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { maziHome } from '../src/paths.js';

/** legacy 类型 → gts 类型（仅顶层类型映射；payload/attributes 原样保留） */
const TYPE_MAP: Record<string, string> = {
    'session.started': 'goal.started',
    'session.ended': 'goal.ended',
};

/** 单行事件迁移；已是 gts 形状返回原行，未知形状返回 null（跳过） */
function migrateLine(line: string): string | null {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.rootGoalId !== undefined) {
        return line; // 已迁移（幂等）
    }
    if (typeof event.sessionId !== 'string') {
        return null; // 非 legacy 且非 gts 形状，跳过不破坏
    }
    const next: Record<string, unknown> = { ...event };
    next.rootGoalId = event.sessionId;
    delete next.sessionId;
    const mapped = TYPE_MAP[event.type as string];
    if (mapped !== undefined) {
        next.type = mapped;
    }
    return JSON.stringify(next);
}

function main(): void {
    const home = maziHome();
    const eventDir = join(home, 'events');
    const backupDir = join(home, 'events.bak');
    if (!existsSync(eventDir)) {
        console.log(`[migrate] 事件目录不存在，跳过：${eventDir}`);
        return;
    }
    mkdirSync(backupDir, { recursive: true });

    let migratedFiles = 0;
    let migratedLines = 0;
    for (const name of readdirSync(eventDir)) {
        if (!name.endsWith('.jsonl')) {
            continue;
        }
        const file = join(eventDir, name);
        const backup = join(backupDir, name);
        if (!existsSync(backup)) {
            copyFileSync(file, backup);
        }
        const raw = readFileSync(file, 'utf8');
        const out: string[] = [];
        let fileChanged = false;
        for (const line of raw.split('\n')) {
            if (line.trim().length === 0) {
                continue;
            }
            try {
                const migrated = migrateLine(line);
                if (migrated === null) {
                    out.push(line); // 未知形状原样保留
                } else if (migrated !== line) {
                    out.push(migrated);
                    fileChanged = true;
                    migratedLines += 1;
                } else {
                    out.push(line);
                }
            } catch {
                out.push(line); // 损坏行保留
            }
        }
        if (fileChanged) {
            writeFileSync(file, `${out.join('\n')}\n`, 'utf8');
            migratedFiles += 1;
            console.log(`[migrate] ${name}: ${out.length} 行已归一化（备份 events.bak/${name}）`);
        }
    }
    console.log(`[migrate] 完成：${migratedFiles} 个文件、${migratedLines} 行事件已迁移 → ${home}`);
}

main();
