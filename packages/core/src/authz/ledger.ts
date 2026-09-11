/**
 * Dataflow ledger — context-generation scoped, versioned and linearizable
 * (§6.5, N7/N8/N11).
 *
 * Writes commit atomically at a single linearization point (monotonic
 * `version`). Adjudication must read a full-order prefix; a barrier waits for
 * in-flight writes, and a timeout fails closed (`LEDGER_BARRIER_TIMEOUT`).
 * Generation switches inherit conservatively: auto-compaction inherits the
 * ledger, only an explicit user flush clears it.
 */

import { contentVersion } from './hash.js';
import { isAtLeastSensitive, type LedgerVersion, type SensitivityLabel } from './types.js';

export type GenerationTrigger =
    | 'session-created'
    | 'user'
    | 'auto-compaction'
    | 'context-destroyed';

export type InheritanceMode = 'full' | 'summary';

export interface LedgerEntry {
    id: string;
    label: SensitivityLabel;
    source: string;
    stepId: string;
    transferDir: 'ingest' | 'egress' | 'none';
    /** Source severance: severed reads never pollute the ledger's flow state. */
    severed: boolean;
    version: LedgerVersion;
}

export interface LedgerWrite {
    label: SensitivityLabel;
    source: string;
    stepId: string;
    transferDir: LedgerEntry['transferDir'];
    severed?: boolean;
}

export interface LedgerSnapshot {
    generationId: string;
    version: LedgerVersion;
    entries: readonly LedgerEntry[];
}

export interface GenerationSwitchEvent {
    type: 'generation-switch';
    reason: GenerationTrigger;
    generationId: string;
    fromGenerationId?: string;
    cleared?: boolean;
    inherited?: InheritanceMode;
    archived?: boolean;
}

export interface EgressAttestationEvent {
    type: 'generation-egress-attestation';
    attestor: string;
    generationId: string;
    ledgerVersion: LedgerVersion;
    timestamp: number;
    scope: string;
}

export type LedgerAuditEvent = GenerationSwitchEvent | EgressAttestationEvent;

export interface LedgerAuditSink {
    log(event: LedgerAuditEvent): void;
}

export interface LedgerOptions {
    generationId?: string;
    audit?: LedgerAuditSink;
    now?: () => number;
}

export class LedgerBarrierTimeoutError extends Error {
    readonly code = 'LEDGER_BARRIER_TIMEOUT' as const;
    constructor(pending: number) {
        super(`账本屏障超时：仍有 ${pending} 笔写未提交（fail-closed）`);
        this.name = 'LedgerBarrierTimeoutError';
    }
}

interface PendingWrite {
    resolve: () => void;
    promise: Promise<void>;
}

export class DataflowLedger {
    private generationId: string;
    private generationSeq: number;
    private entries: LedgerEntry[] = [];
    private version: LedgerVersion = 0;
    private pending = new Map<number, PendingWrite>();
    private pendingSeq = 0;
    private readonly audit?: LedgerAuditSink;
    private readonly now: () => number;

    constructor(opts: LedgerOptions = {}) {
        this.generationId = opts.generationId ?? 'gen-1';
        this.generationSeq = 1;
        this.audit = opts.audit;
        this.now = opts.now ?? (() => Date.now());
        this.emit({
            type: 'generation-switch',
            reason: 'session-created',
            generationId: this.generationId,
        });
    }

    get currentVersion(): LedgerVersion {
        return this.version;
    }

    currentGeneration(): string {
        return this.generationId;
    }

    /** Register an in-flight write; `barrier` waits for it to commit or abort. */
    beginWrite(): number {
        const id = ++this.pendingSeq;
        let resolve!: () => void;
        const promise = new Promise<void>((r) => {
            resolve = r;
        });
        this.pending.set(id, { resolve, promise });
        return id;
    }

    /** Atomic linearization point: append + version increment happen together. */
    commit(handle: number, write: LedgerWrite): LedgerVersion {
        this.version += 1;
        const entry: LedgerEntry = {
            id: `${this.generationId}:${this.version}`,
            label: write.label,
            source: write.source,
            stepId: write.stepId,
            transferDir: write.transferDir,
            severed: write.severed === true,
            version: this.version,
        };
        this.entries.push(entry);
        this.settle(handle);
        return this.version;
    }

    abort(handle: number): void {
        this.settle(handle);
    }

    private settle(handle: number): void {
        const pending = this.pending.get(handle);
        if (pending) {
            this.pending.delete(handle);
            pending.resolve();
        }
    }

    /** Wait for in-flight writes, then return the committed full-order prefix. */
    async barrier(timeoutMs = 0): Promise<LedgerSnapshot> {
        if (this.pending.size > 0) {
            const waiting = Promise.all([...this.pending.values()].map((p) => p.promise));
            if (timeoutMs <= 0) {
                await waiting;
            } else {
                let timer: ReturnType<typeof setTimeout> | undefined;
                const timeout = new Promise<never>((_, reject) => {
                    timer = setTimeout(
                        () => reject(new LedgerBarrierTimeoutError(this.pending.size)),
                        timeoutMs,
                    );
                });
                try {
                    await Promise.race([waiting, timeout]);
                } finally {
                    if (timer) clearTimeout(timer);
                }
            }
        }
        return this.snapshot();
    }

    /**
     * Full-order prefix read. A requested version beyond the current one is
     * clamped to current; the returned `version` may advance, so callers must
     * re-read when they observe advancement (N8).
     */
    snapshot(version?: LedgerVersion): LedgerSnapshot {
        const target = version === undefined ? this.version : Math.min(version, this.version);
        return {
            generationId: this.generationId,
            version: target,
            entries: this.entries.filter((e) => e.version <= target),
        };
    }

    /** Missing/insufficient ledger state must be treated as broken (N5). */
    hasSensitiveIngest(snapshot?: LedgerSnapshot): boolean {
        const view = snapshot ?? this.snapshot();
        return view.entries.some(
            (e) => e.transferDir === 'ingest' && isAtLeastSensitive(e.label) && !e.severed,
        );
    }

    sensitiveIngestEntries(snapshot?: LedgerSnapshot): readonly LedgerEntry[] {
        const view = snapshot ?? this.snapshot();
        return view.entries.filter(
            (e) => e.transferDir === 'ingest' && isAtLeastSensitive(e.label) && !e.severed,
        );
    }

    /**
     * Generation switch (N11/P19). Only an explicit user flush clears the
     * ledger; auto-compaction inherits (full event set by default, boolean
     * summary in the minimal deployment).
     */
    switchGeneration(trigger: GenerationTrigger, mode: InheritanceMode = 'full'): LedgerSnapshot {
        const from = this.generationId;
        this.generationSeq += 1;
        this.generationId = `gen-${this.generationSeq}`;
        this.version = 0;

        if (trigger === 'session-created') {
            this.entries = [];
            this.emit({
                type: 'generation-switch',
                reason: trigger,
                generationId: this.generationId,
            });
        } else if (trigger === 'user') {
            this.entries = [];
            this.emit({
                type: 'generation-switch',
                reason: trigger,
                generationId: this.generationId,
                fromGenerationId: from,
                cleared: true,
            });
        } else if (trigger === 'auto-compaction') {
            const inherited = mode === 'full' ? this.inheritFull() : this.inheritSummary();
            this.entries = inherited;
            // Inherited events occupy the new generation's version prefix.
            this.version = inherited.length;
            this.emit({
                type: 'generation-switch',
                reason: trigger,
                generationId: this.generationId,
                fromGenerationId: from,
                inherited: mode,
            });
        } else {
            this.emit({
                type: 'generation-switch',
                reason: trigger,
                generationId: this.generationId,
                fromGenerationId: from,
                archived: true,
            });
            this.entries = [];
        }
        return this.snapshot();
    }

    private inheritFull(): LedgerEntry[] {
        const sensitive = this.entries.filter(
            (e) => e.transferDir === 'ingest' && isAtLeastSensitive(e.label),
        );
        return sensitive.map((e, index) => ({ ...e, version: index + 1 }));
    }

    private inheritSummary(): LedgerEntry[] {
        const any = this.entries.some(
            (e) => e.transferDir === 'ingest' && isAtLeastSensitive(e.label),
        );
        if (!any) return [];
        return [
            {
                id: `${this.generationId}:summary`,
                label: 'sensitive',
                source: 'inherited-summary',
                stepId: '',
                transferDir: 'ingest',
                severed: false,
                version: 1,
            },
        ];
    }

    private emit(event: LedgerAuditEvent): void {
        this.audit?.log(event);
    }

    /** Content version of the ledger state — used for attribution/tests. */
    stateVersion(): number {
        return contentVersion({ generationId: this.generationId, entries: this.entries });
    }
}

// ============================================================
// R3-flow condition verdict
// ============================================================

export type ConditionVerdict = 'satisfied' | 'broken';

/**
 * Adjudicate a `no-sensitive-ingest` predicate against a ledger snapshot. A
 * missing snapshot (ledger unavailable) is broken — fail-safe (N5).
 */
export function evaluateNoSensitiveIngest(snapshot: LedgerSnapshot | undefined): ConditionVerdict {
    if (!snapshot) return 'broken';
    const broken = snapshot.entries.some(
        (e) => e.transferDir === 'ingest' && isAtLeastSensitive(e.label) && !e.severed,
    );
    return broken ? 'broken' : 'satisfied';
}

// ============================================================
// Generation-level informed attestation (A2a/A2b)
// ============================================================

export interface EgressAttestation {
    attestor: string;
    generationId: string;
    ledgerVersion: LedgerVersion;
    timestamp: number;
    scope: string;
}

/**
 * A2a: validity is decided synchronously against the current ledger version
 * prefix — valid iff no ≥sensitive unsevered read was committed after the
 * signed version. No asynchronous listener, no invalidation window.
 */
export function isAttestationValid(
    attestation: EgressAttestation,
    snapshot: LedgerSnapshot,
): boolean {
    if (attestation.generationId !== snapshot.generationId) return false;
    return !snapshot.entries.some(
        (e) =>
            e.version > attestation.ledgerVersion &&
            e.transferDir === 'ingest' &&
            isAtLeastSensitive(e.label) &&
            !e.severed,
    );
}

/**
 * A2b: the approval echo must tell the truth about the generation state. Never
 * "I confirm no sensitive residue" — the trigger for the confirmation is
 * exactly that residue.
 */
export function buildAttestationText(
    snapshot: LedgerSnapshot,
    derivedLabelTargets: readonly string[],
): string {
    const sensitive = snapshot.entries.filter(
        (e) => e.transferDir === 'ingest' && isAtLeastSensitive(e.label) && !e.severed,
    );
    const sources = [...new Set(sensitive.map((e) => e.source))];
    const targets = derivedLabelTargets;
    return [
        `本世代已发生 ${sensitive.length} 次 sensitive 读（来源列表：${sources.join('、') || '无'}）；`,
        `工作区存在 ${targets.length} 个 derived-label 文件（列表：${targets.join('、') || '无'}）；`,
        '签署后本世代 egress 将静默。',
    ].join('');
}

export function makeAttestation(
    attestor: string,
    scope: string,
    snapshot: LedgerSnapshot,
    timestamp: number,
): EgressAttestation {
    return {
        attestor,
        generationId: snapshot.generationId,
        ledgerVersion: snapshot.version,
        timestamp,
        scope,
    };
}
