/**
 * R5f 一次性历史迁移 CLI：把旧 JSONL 的权限/骨架白名单迁入 SQLite 权威库。
 *
 * 用法（tsx 或编译后 node dist/scripts/legacy-import-cli.js）：
 *   --source-dir <dir>   旧 JSONL 目录（默认 $MAZI_HOME/events 或 ~/.mazi/events）
 *   --db <path>          目标权威库（默认 source-dir 旁 events.db）
 *   --dry-run            只扫描统计，不写库
 *
 * 不自动删除源文件；校验通过后由运维显式清理。
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { importLegacyEvents, LEGACY_IMPORT_TYPES } from '../events/legacy-import.js';
import { SqliteEventStore } from '../events/sqlite-event-store.js';

function arg(name: string): string | undefined {
    const flag = `--${name}=`;
    for (const argv of process.argv.slice(2)) {
        if (argv.startsWith(flag)) return argv.slice(flag.length);
    }
    return undefined;
}

function main(): void {
    const home = process.env.MAZI_HOME || join(homedir(), '.mazi');
    const sourceDir = arg('source-dir') ?? join(home, 'events');
    const dbPath = arg('db') ?? join(sourceDir, 'events.db');
    const dryRun = process.argv.includes('--dry-run');

    if (!existsSync(sourceDir)) {
        console.error(`源目录不存在: ${sourceDir}`);
        process.exit(1);
    }

    if (dryRun) {
        const stats = importLegacyEvents(sourceDir, { append() {} });
        console.log(
            `[dry-run] 扫描 ${stats.scanned} 行，可迁移 ${stats.imported}，重复 ${stats.duplicates}，跳过 ${stats.skipped}`,
        );
        return;
    }

    const store = new SqliteEventStore(dbPath);
    try {
        const stats = importLegacyEvents(sourceDir, store);
        const inDb = store.query({ types: LEGACY_IMPORT_TYPES }).length;
        console.log(
            `迁移完成：写入 ${stats.imported}（重复 ${stats.duplicates}，跳过 ${stats.skipped}，扫描 ${stats.scanned}）；库内白名单累计 ${inDb}`,
        );
    } finally {
        store.close();
    }
}

main();
