/**
 * Vendor-neutral memory bundle. The payload contains semantic records and
 * provenance only; embeddings/indexes are rebuildable derived data.
 */

import { createHash } from 'node:crypto';
import { authz, type HarnessEvent } from '@mazi/core';
import type { MemoryManager } from './memory.js';
import type { MemoryItem, MemoryStore } from './store.js';

export const MEMORY_BUNDLE_FORMAT = 'mazi-memory-bundle' as const;
export const MEMORY_BUNDLE_SCHEMA_VERSION = 1 as const;

export interface MemoryBundle {
    format: typeof MEMORY_BUNDLE_FORMAT;
    schemaVersion: typeof MEMORY_BUNDLE_SCHEMA_VERSION;
    exportedAt: number;
    records: MemoryItem[];
    /** Audit stays a separate domain; memory recall never treats these as facts. */
    auditTrails?: AuditTrailBundle[];
    checksum: string;
}

export interface AuditTrailBundle {
    rootGoalId: string;
    head: string;
    events: HarnessEvent[];
}

function checksum(
    records: readonly MemoryItem[],
    auditTrails?: readonly AuditTrailBundle[],
): string {
    return createHash('sha256')
        .update(authz.stableStringify({ records, auditTrails: auditTrails ?? [] }))
        .digest('hex');
}

export async function exportMemoryBundle(
    source: MemoryManager | MemoryStore,
    now: () => number = Date.now,
    auditTrails?: readonly AuditTrailBundle[],
): Promise<MemoryBundle> {
    const records = [...(await source.all())];
    return {
        format: MEMORY_BUNDLE_FORMAT,
        schemaVersion: MEMORY_BUNDLE_SCHEMA_VERSION,
        exportedAt: now(),
        records,
        ...(auditTrails !== undefined && auditTrails.length > 0
            ? { auditTrails: auditTrails.map((trail) => ({ ...trail })) }
            : {}),
        checksum: checksum(records, auditTrails),
    };
}

export async function importMemoryBundle(
    target: MemoryManager | MemoryStore,
    bundle: MemoryBundle,
): Promise<{ imported: number }> {
    if (
        bundle.format !== MEMORY_BUNDLE_FORMAT ||
        bundle.schemaVersion !== MEMORY_BUNDLE_SCHEMA_VERSION ||
        !Array.isArray(bundle.records)
    ) {
        throw new Error('不支持的 memory bundle');
    }
    const auditTrails = Array.isArray(bundle.auditTrails) ? bundle.auditTrails : undefined;
    if (bundle.checksum !== checksum(bundle.records, auditTrails)) {
        throw new Error('memory bundle checksum 校验失败');
    }
    if ('remember' in target) {
        await target.remember(bundle.records);
    } else {
        await target.append(bundle.records);
    }
    return { imported: bundle.records.length };
}
