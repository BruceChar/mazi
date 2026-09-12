/**
 * StorageService —— SQLite 只读看板（docs/web/存储面板设计.md）。
 *
 * 把 $MAZI_HOME/mazi.db 当作可观察对象：动态发现表、统计行数与 dbstat 占用、
 * 分页浏览与全库关键字搜索。全部只读，不提供任何写操作。
 * 表名先经 sqlite_master 校验再以双引号转义，过滤值一律走绑定参数。
 */
import { existsSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import { ApiRuntimeService } from '../common/runtime.service.js';

export interface StorageColumn {
    name: string;
    type: string;
    pk: boolean;
}

export interface StorageTableStats {
    name: string;
    columns: StorageColumn[];
    rows: number;
    /** dbstat 汇总的表数据页字节；dbstat 不可用时为 null。 */
    bytes: number | null;
    indexBytes: number;
    indexes: number;
}

export interface StorageOverview {
    driver: 'sqlite';
    path: string;
    exists: boolean;
    fileBytes: number;
    walBytes: number;
    pageSize: number;
    pageCount: number;
    freePages: number;
    freeBytes: number;
    sizeSource: 'dbstat' | 'unavailable';
    tables: StorageTableStats[];
    totals: { tables: number; rows: number; bytes: number; indexBytes: number; dataBytes: number };
    updatedAt: number;
}

export interface StorageTablePage {
    table: string;
    columns: string[];
    rows: Record<string, unknown>[];
    total: number;
    offset: number;
    limit: number;
    query: string;
}

export interface StorageSearchHit {
    table: string;
    matches: number;
    rows: Record<string, unknown>[];
}

export interface StorageSearchResult {
    query: string;
    total: number;
    tables: StorageSearchHit[];
}

type Row = Record<string, unknown>;
/** node:sqlite 绑定参数允许的标量类型（过滤值只有字符串/数字）。 */
type SqlParam = string | number | bigint | null | Uint8Array;

const MAX_TABLE_ROWS = 200;
const MAX_SEARCH_ROWS = 50;

function quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

/** BigInt/Buffer 归一，保证 JSON 可序列化。 */
function normalizeValue(value: unknown): unknown {
    if (typeof value === 'bigint') {
        const min = BigInt(Number.MIN_SAFE_INTEGER);
        const max = BigInt(Number.MAX_SAFE_INTEGER);
        return value >= min && value <= max ? Number(value) : value.toString();
    }
    if (value instanceof Uint8Array) return `<BLOB ${value.byteLength} bytes>`;
    return value;
}

function normalizeRow(row: Row): Row {
    const out: Row = {};
    for (const [key, value] of Object.entries(row)) out[key] = normalizeValue(value);
    return out;
}

function safeFileSize(path: string): number {
    try {
        return statSync(path).size;
    } catch {
        return 0;
    }
}

function firstNumber(row: Row | undefined): number {
    if (!row) return 0;
    const value = Object.values(row)[0];
    return typeof value === 'number' ? value : Number(value ?? 0);
}

@Injectable()
export class StorageService {
    constructor(private readonly runtime: ApiRuntimeService) {}

    private get dbPath(): string {
        return this.runtime.homePaths.dbPath;
    }

    /** 只读连接；readOnly 打不开时退回只读用途的普通连接。 */
    private open(): DatabaseSync | null {
        try {
            return new DatabaseSync(this.dbPath, { readOnly: true });
        } catch {
            try {
                return new DatabaseSync(this.dbPath);
            } catch {
                return null;
            }
        }
    }

    private listTables(db: DatabaseSync): string[] {
        const rows = db
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .all() as Row[];
        return rows.map((row) => String(row.name));
    }

    private listIndexes(db: DatabaseSync): Array<{ name: string; table: string }> {
        const rows = db
            .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index'")
            .all() as Row[];
        return rows.map((row) => ({ name: String(row.name), table: String(row.tbl_name) }));
    }

    private columnsOf(db: DatabaseSync, table: string): StorageColumn[] {
        const rows = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Row[];
        return rows.map((row) => ({
            name: String(row.name),
            type: String(row.type ?? ''),
            pk: Number(row.pk ?? 0) > 0,
        }));
    }

    private isUserTable(db: DatabaseSync, table: string): boolean {
        const row = db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get(table) as Row | undefined;
        return row !== undefined && !table.startsWith('sqlite_');
    }

    private countRows(db: DatabaseSync, table: string, where: string, params: SqlParam[]): number {
        const row = db
            .prepare(`SELECT COUNT(*) AS c FROM ${quoteIdent(table)} ${where}`)
            .get(...params) as Row | undefined;
        return Number(row?.c ?? 0);
    }

    /** 所有列的字面包含匹配（大小写不敏感，不解析 LIKE 通配符）。 */
    private buildFilter(
        columns: StorageColumn[],
        query: string,
    ): { where: string; params: SqlParam[] } {
        if (query.length === 0) return { where: '', params: [] };
        const clauses = columns.map(
            (column) => `instr(lower(CAST(${quoteIdent(column.name)} AS TEXT)), lower(?)) > 0`,
        );
        return { where: `WHERE ${clauses.join(' OR ')}`, params: columns.map(() => query) };
    }

    /** 优先主键排序，无主键退回 rowid，保证分页稳定。 */
    private orderBy(columns: StorageColumn[]): string {
        const keys = columns.filter((column) => column.pk).map((column) => quoteIdent(column.name));
        return keys.length > 0 ? `ORDER BY ${keys.join(', ')}` : 'ORDER BY rowid';
    }

    /** dbstat 按对象汇总占用；不可用时返回 null 走降级展示。 */
    private readDbStat(db: DatabaseSync): Map<string, number> | null {
        try {
            const rows = db
                .prepare('SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name')
                .all() as Row[];
            const stats = new Map<string, number>();
            for (const row of rows) stats.set(String(row.name), Number(row.bytes ?? 0));
            return stats;
        } catch {
            return null;
        }
    }

    private selectRows(
        db: DatabaseSync,
        table: string,
        columns: StorageColumn[],
        query: string,
        limit: number,
        offset: number,
    ): Record<string, unknown>[] {
        const filter = this.buildFilter(columns, query);
        const rows = db
            .prepare(
                `SELECT * FROM ${quoteIdent(table)} ${filter.where} ${this.orderBy(columns)} LIMIT ? OFFSET ?`,
            )
            .all(...filter.params, limit, offset) as Row[];
        return rows.map(normalizeRow);
    }

    /** 存储总览：文件/页统计 + 逐表行数与占用。 */
    overview(): StorageOverview {
        const path = this.dbPath;
        const empty: StorageOverview = {
            driver: 'sqlite',
            path,
            exists: false,
            fileBytes: 0,
            walBytes: 0,
            pageSize: 0,
            pageCount: 0,
            freePages: 0,
            freeBytes: 0,
            sizeSource: 'unavailable',
            tables: [],
            totals: { tables: 0, rows: 0, bytes: 0, indexBytes: 0, dataBytes: 0 },
            updatedAt: Date.now(),
        };
        if (!existsSync(path)) return empty;
        const db = this.open();
        if (!db) return empty;
        try {
            const pageSize = firstNumber(db.prepare('PRAGMA page_size').get() as Row);
            const pageCount = firstNumber(db.prepare('PRAGMA page_count').get() as Row);
            const freePages = firstNumber(db.prepare('PRAGMA freelist_count').get() as Row);
            const stat = this.readDbStat(db);
            const indexesByTable = new Map<string, string[]>();
            for (const index of this.listIndexes(db)) {
                const list = indexesByTable.get(index.table) ?? [];
                list.push(index.name);
                indexesByTable.set(index.table, list);
            }
            const tables: StorageTableStats[] = this.listTables(db).map((name) => {
                const columns = this.columnsOf(db, name);
                const indexNames = indexesByTable.get(name) ?? [];
                const indexBytes = stat
                    ? indexNames.reduce((sum, index) => sum + (stat.get(index) ?? 0), 0)
                    : 0;
                return {
                    name,
                    columns,
                    rows: this.countRows(db, name, '', []),
                    bytes: stat ? (stat.get(name) ?? 0) : null,
                    indexBytes,
                    indexes: indexNames.length,
                };
            });
            tables.sort((a, b) => {
                const delta = (b.bytes ?? -1) - (a.bytes ?? -1);
                return delta !== 0 ? delta : b.rows - a.rows;
            });
            const fileBytes = safeFileSize(path);
            return {
                driver: 'sqlite',
                path,
                exists: true,
                fileBytes,
                walBytes: safeFileSize(`${path}-wal`),
                pageSize,
                pageCount,
                freePages,
                freeBytes: freePages * pageSize,
                sizeSource: stat ? 'dbstat' : 'unavailable',
                tables,
                totals: {
                    tables: tables.length,
                    rows: tables.reduce((sum, table) => sum + table.rows, 0),
                    bytes: tables.reduce((sum, table) => sum + (table.bytes ?? 0), 0),
                    indexBytes: tables.reduce((sum, table) => sum + table.indexBytes, 0),
                    dataBytes: fileBytes,
                },
                updatedAt: Date.now(),
            };
        } finally {
            db.close();
        }
    }

    /** 单表分页数据；表不存在（含 SQLite 内部表）→ 404。 */
    tablePage(
        name: string,
        options: { limit: number; offset: number; query: string },
    ): StorageTablePage {
        const notFound = () => new ApiError(404, 'table not found');
        if (!existsSync(this.dbPath)) throw notFound();
        const db = this.open();
        if (!db) throw notFound();
        try {
            if (!this.isUserTable(db, name)) throw notFound();
            const columns = this.columnsOf(db, name);
            const limit = Math.min(Math.max(options.limit, 1), MAX_TABLE_ROWS);
            const offset = Math.max(options.offset, 0);
            const filter = this.buildFilter(columns, options.query);
            return {
                table: name,
                columns: columns.map((column) => column.name),
                rows: this.selectRows(db, name, columns, options.query, limit, offset),
                total: this.countRows(db, name, filter.where, filter.params),
                offset,
                limit,
                query: options.query,
            };
        } finally {
            db.close();
        }
    }

    /** 全库搜索：逐表统计命中，返回匹配最多的前若干行。 */
    search(query: string, limit: number): StorageSearchResult {
        if (query.length === 0 || !existsSync(this.dbPath)) {
            return { query, total: 0, tables: [] };
        }
        const db = this.open();
        if (!db) return { query, total: 0, tables: [] };
        try {
            const perTable = Math.min(Math.max(limit, 1), MAX_SEARCH_ROWS);
            const hits: StorageSearchHit[] = [];
            let total = 0;
            for (const table of this.listTables(db)) {
                const columns = this.columnsOf(db, table);
                const filter = this.buildFilter(columns, query);
                const matches = this.countRows(db, table, filter.where, filter.params);
                if (matches === 0) continue;
                hits.push({
                    table,
                    matches,
                    rows: this.selectRows(db, table, columns, query, perTable, 0),
                });
                total += matches;
            }
            hits.sort((a, b) => b.matches - a.matches);
            return { query, total, tables: hits };
        } finally {
            db.close();
        }
    }
}
