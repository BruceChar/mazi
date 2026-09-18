/**
 * Dataflow ledger and residue taint table (V3 §6.3–§6.5).
 *
 * The ledger records sensitive reads scoped to a period (context generation).
 * Writes linearize at a monotonic version. INV-A: a sensitive read's commit must
 * precede the value becoming visible to the model. INV-B: egress adjudication
 * reads the latest committed version and re-adjudicates if a newer commit
 * appears. Autocompaction inherits the ledger; only an explicit user reset
 * clears it. Taint marking (mechanism 5) is applied on write when the ledger
 * holds an unsevered sensitive read and is cleared per file, decoupled from
 * reset.
 */

import { normalizeAssetPath } from './glob.js';
import { contentVersion } from './hash.js';
import { isAtLeastSensitive, type LedgerVersion, type SensitivityLabel } from './types.js';

export type PeriodTrigger =
    | 'session-created'
    | 'user-reset'
    | 'auto-compaction'
    | 'session-destroyed';

export type InheritanceMode = 'full' | 'summary';

export interface LedgerEntry {
    id: string;
    label: SensitivityLabel;
    source: string;
    stepId: string;
    /** Severed reads never entered the context and cannot pollute egress. */
    severed: boolean;
    /** db projection accounting: only selected columns are recorded. */
    columns?: string[];
    version: LedgerVersion;
}

export interface LedgerWrite {
    label: SensitivityLabel;
    source: string;
    stepId: string;
    severed?: boolean;
    columns?: string[];
}

export interface LedgerSnapshot {
    periodId: string;
    version: LedgerVersion;
    entries: readonly LedgerEntry[];
}

export interface EgressVerdict {
    broken: boolean;
    version: LedgerVersion;
    sources: string[];
    entries: readonly LedgerEntry[];
}

export interface LedgerAuditEvent {
    type: string;
    [key: string]: unknown;
}

export interface LedgerAuditSink {
    log(event: LedgerAuditEvent): void;
}

export interface LedgerOptions {
    periodId?: string;
    audit?: LedgerAuditSink;
}

export class DataflowLedger {
    private periodId: string;
    private periodSeq: number;
    private entries: LedgerEntry[] = [];
    private version: LedgerVersion = 0;
    private readonly audit?: LedgerAuditSink;

    constructor(opts: LedgerOptions = {}) {
        this.periodId = opts.periodId ?? 'period-1';
        this.periodSeq = 1;
        this.audit = opts.audit;
        this.emit({ type: 'period-switch', reason: 'session-created', periodId: this.periodId });
    }

    get currentVersion(): LedgerVersion {
        return this.version;
    }

    currentPeriod(): string {
        return this.periodId;
    }

    /**
     * Atomic linearization point (INV-A). Callers must commit before making the
     * read's value visible to the model; a failed commit means the value is not
     * returned (fail-closed).
     */
    commit(write: LedgerWrite): LedgerVersion {
        this.version += 1;
        const entry: LedgerEntry = {
            id: `${this.periodId}:${this.version}`,
            label: write.label,
            source: write.source,
            stepId: write.stepId,
            severed: write.severed === true,
            version: this.version,
        };
        if (write.columns !== undefined) entry.columns = [...write.columns];
        this.entries.push(entry);
        this.emit({ type: 'ledger-write', entry: { ...entry } });
        return this.version;
    }

    /** Full-order prefix read; a version beyond the head is clamped to the head. */
    snapshot(version?: LedgerVersion): LedgerSnapshot {
        const target = version === undefined ? this.version : Math.min(version, this.version);
        return {
            periodId: this.periodId,
            version: target,
            entries: this.entries.filter((e) => e.version <= target),
        };
    }

    hasSensitiveUnsevered(): boolean {
        return this.sensitiveEntries().length > 0;
    }

    /** INV-B: adjudicate against the latest committed version. */
    adjudicate(): EgressVerdict {
        const snap = this.snapshot();
        const entries = this.unseveredSensitive(snap.entries);
        return {
            broken: entries.length > 0,
            version: snap.version,
            sources: [...new Set(entries.map((e) => e.source))],
            entries,
        };
    }

    /** True when a newer commit appeared between adjudication and execution. */
    recheck(version: LedgerVersion): boolean {
        return version < this.version;
    }

    /**
     * Period switch. Only an explicit user reset clears the ledger;
     * autocompaction inherits (full entry set, or a boolean summary in the
     * minimal deployment). Destruction archives and clears.
     */
    switchPeriod(trigger: PeriodTrigger, mode: InheritanceMode = 'full'): LedgerSnapshot {
        const from = this.periodId;
        this.periodSeq += 1;
        this.periodId = `period-${this.periodSeq}`;
        this.version = 0;

        if (trigger === 'auto-compaction') {
            this.entries = mode === 'full' ? this.inheritFull() : this.inheritSummary();
            this.version = this.entries.length;
            this.emit({
                type: 'period-switch',
                reason: trigger,
                periodId: this.periodId,
                fromPeriodId: from,
                inherited: mode,
            });
        } else {
            this.entries = [];
            this.emit({
                type: 'period-switch',
                reason: trigger,
                periodId: this.periodId,
                fromPeriodId: from,
                cleared: trigger === 'user-reset',
                archived: trigger === 'session-destroyed',
            });
        }
        return this.snapshot();
    }

    /** Content version of the ledger state — attribution / tests. */
    stateVersion(): number {
        return contentVersion({ periodId: this.periodId, entries: this.entries });
    }

    private sensitiveEntries(): readonly LedgerEntry[] {
        return this.unseveredSensitive(this.entries);
    }

    private unseveredSensitive(entries: readonly LedgerEntry[]): LedgerEntry[] {
        return entries.filter((e) => !e.severed && isAtLeastSensitive(e.label));
    }

    private inheritFull(): LedgerEntry[] {
        return this.sensitiveEntries().map((e, index) => ({ ...e, version: index + 1 }));
    }

    private inheritSummary(): LedgerEntry[] {
        if (this.sensitiveEntries().length === 0) return [];
        return [
            {
                id: `${this.periodId}:summary`,
                label: 'sensitive',
                source: 'inherited-summary',
                stepId: '',
                severed: false,
                version: 1,
            },
        ];
    }

    private emit(event: LedgerAuditEvent): void {
        this.audit?.log(event);
    }
}

// ============================================================
// Mechanism 5: residue taint table
// ============================================================

export interface TaintAppliedEvent {
    type: 'taint-applied';
    target: string;
    ledgerVersion: LedgerVersion;
}

export interface TaintClearedEvent {
    type: 'taint-cleared';
    attestor: string;
    target: string;
    reason: string;
}

export type TaintAuditEvent = TaintAppliedEvent | TaintClearedEvent;

export interface TaintAuditSink {
    log(event: TaintAuditEvent): void;
}

export interface TaintOptions {
    home?: string;
    audit?: TaintAuditSink;
}

const TAINT_LABEL = 'sensitive' as const;

/**
 * The taint table is a conservative approximation of workspace residue. It only
 * participates in ledger adjudication — it never drives the hard floor — and its
 * clearing is a per-file security decision independent of ledger reset.
 */
export class TaintTable {
    private readonly taints = new Map<string, LedgerVersion>();
    private readonly home?: string;
    private readonly audit?: TaintAuditSink;

    constructor(opts: TaintOptions = {}) {
        this.home = opts.home;
        this.audit = opts.audit;
    }

    /** Apply a taint iff the ledger holds an unsevered sensitive read. */
    markFromLedger(target: string, ledger: DataflowLedger): boolean {
        const entries = ledger.adjudicate().entries;
        if (entries.length === 0) return false;
        const normalized = normalizeAssetPath(target, this.home);
        const version = ledger.currentVersion;
        const existing = this.taints.get(normalized);
        this.taints.set(normalized, Math.max(existing ?? 0, version));
        this.audit?.log({ type: 'taint-applied', target: normalized, ledgerVersion: version });
        return true;
    }

    has(target: string): boolean {
        return this.taints.has(normalizeAssetPath(target, this.home));
    }

    /** Taint labels are capped at sensitive and only tighten the flow layer. */
    labelFor(target: string): typeof TAINT_LABEL | undefined {
        return this.has(target) ? TAINT_LABEL : undefined;
    }

    ledgerVersionOf(target: string): LedgerVersion | undefined {
        return this.taints.get(normalizeAssetPath(target, this.home));
    }

    targets(): string[] {
        return [...this.taints.keys()];
    }

    /** Explicit per-file clear; user reset must NOT call this (N20 decoupling). */
    clear(target: string, attestor: string, reason: string): boolean {
        const normalized = normalizeAssetPath(target, this.home);
        if (!this.taints.delete(normalized)) return false;
        this.audit?.log({ type: 'taint-cleared', attestor, target: normalized, reason });
        return true;
    }

    /** sandbox/draft-domain taints die with the domain teardown. */
    clearByDomainTeardown(): number {
        const count = this.taints.size;
        this.taints.clear();
        return count;
    }
}
