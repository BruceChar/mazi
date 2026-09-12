/**
 * storage —— 存储看板纯计算层（docs/web/存储面板设计.md §4）。
 * 只做「总览/表数据 → 面板视图」投影：占用分段、占比、单元格预览/格式化、分页钳制；
 * 无副作用、不依赖 Vue，便于单测。
 */

export interface StorageColumn {
    name: string;
    type: string;
    pk: boolean;
}

export interface StorageTableStats {
    name: string;
    columns: StorageColumn[];
    rows: number;
    bytes: number | null;
    indexBytes: number;
    indexes: number;
}

export interface StorageTotals {
    tables: number;
    rows: number;
    bytes: number;
    indexBytes: number;
    dataBytes: number;
}

export interface StorageOverview {
    driver: string;
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
    totals: StorageTotals;
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

/** 占用条配色，复用观测看板的分段 CSS 变量。 */
export const STORAGE_PALETTE = [
    '--seg-assistant',
    '--seg-input',
    '--seg-toolcall',
    '--seg-observation',
    '--seg-system',
    '--seg-schema',
    '--seg-user',
    '--seg-optional',
] as const;

export interface StorageUsageSegment {
    key: string;
    label: string;
    bytes: number;
    share: number;
    colorVar: string;
}

/** 所有有字节数的表占用合计；null（dbstat 不可用）按 0 计。 */
export function totalTableBytes(tables: StorageTableStats[]): number {
    return tables.reduce((sum, table) => sum + (table.bytes ?? 0), 0);
}

/** 单表占比（0..1）；非法输入返回 0。 */
export function sizeShare(bytes: number | null | undefined, total: number): number {
    if (!bytes || !total || total <= 0) return 0;
    return bytes / total;
}

/** Top N 表占用分段，其余聚合成「其他 N 张表」；无有效字节返回空数组。 */
export function usageSegments(tables: StorageTableStats[], maxSegments = 6): StorageUsageSegment[] {
    const sized = tables
        .filter((table) => typeof table.bytes === 'number' && table.bytes > 0)
        .slice()
        .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
    const total = sized.reduce((sum, table) => sum + (table.bytes ?? 0), 0);
    if (total <= 0) return [];
    const head = sized.slice(0, Math.max(1, maxSegments));
    const tail = sized.slice(Math.max(1, maxSegments));
    const segments: StorageUsageSegment[] = head.map((table, index) => ({
        key: table.name,
        label: table.name,
        bytes: table.bytes ?? 0,
        share: (table.bytes ?? 0) / total,
        colorVar: STORAGE_PALETTE[index % STORAGE_PALETTE.length],
    }));
    if (tail.length > 0) {
        const bytes = tail.reduce((sum, table) => sum + (table.bytes ?? 0), 0);
        segments.push({
            key: '__other__',
            label: `其他 ${tail.length} 张表`,
            bytes,
            share: bytes / total,
            colorVar: STORAGE_PALETTE[segments.length % STORAGE_PALETTE.length],
        });
    }
    return segments;
}

function collapseText(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxLength: number): string {
    return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

/** 单元格单行预览：折叠空白、对象序列化、超长截断。 */
export function tableRowPreview(value: unknown, maxLength = 80): string {
    if (value === null || value === undefined) return '';
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return truncate(collapseText(text), maxLength);
}

/** 单元格展开文本：可解析的 JSON 缩进美化，普通文本原样。 */
export function prettyCellText(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value, null, 2);
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
                return JSON.stringify(JSON.parse(trimmed), null, 2);
            } catch {
                return value;
            }
        }
        return value;
    }
    return String(value);
}

/** 总页数，至少 1（空表也有第 1 页）。 */
export function storagePageCount(total: number, limit: number): number {
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(limit) || limit <= 0) return 1;
    return Math.max(1, Math.ceil(total / limit));
}

/** 页码钳制到 [1, pageCount]。 */
export function clampPage(page: number, pageCount: number): number {
    const upper = Math.max(1, Math.floor(pageCount));
    if (!Number.isFinite(page)) return 1;
    return Math.min(Math.max(1, Math.floor(page)), upper);
}
