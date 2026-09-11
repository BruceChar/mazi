/**
 * Derived Label Overlay (A1 three-axis correction, §6.8; N17/N20).
 *
 * The overlay is a session-level conservative approximation of workspace data
 * residue: it is applied at evaluation point ⑩ when the ledger (including the
 * current call's own read events) holds an unsevered ≥sensitive read. It is
 * capped at `sensitive`, tightens the flow layer only (never the hard layer,
 * P24), and its lifetime is manual-clear for workspace and sandbox-teardown
 * for sandbox/draft. Clearing is decoupled from flush (N20/P26).
 */

import { normalizeAssetPath } from './glob.js';
import type { DataflowLedger, LedgerSnapshot } from './ledger.js';
import { type DerivedLabel, maxLabel, type ResolvedLabel } from './types.js';

export interface DerivedLabelAppliedEvent {
    type: 'derived-label-applied';
    target: string;
    label: 'sensitive';
    derivedFrom: string[];
    ledgerVersion: number;
}

export interface DerivedLabelClearedEvent {
    type: 'derived-label-cleared';
    attestor: string;
    target: string;
    reason: string;
}

export type OverlayAuditEvent = DerivedLabelAppliedEvent | DerivedLabelClearedEvent;

export interface OverlayAuditSink {
    log(event: OverlayAuditEvent): void;
}

export type OverlayDomain = 'workspace' | 'sandbox' | 'draft';

export interface OverlayOptions {
    domain?: OverlayDomain;
    home?: string;
    audit?: OverlayAuditSink;
}

const WORKSPACE_LIFETIME = 'manual-clear' as const;
const DOMAIN_LIFETIME = 'sandbox-teardown' as const;

export class DerivedLabelOverlayManager {
    private readonly overlays = new Map<string, DerivedLabel>();
    private readonly domain: OverlayDomain;
    private readonly home?: string;
    private readonly audit?: OverlayAuditSink;

    constructor(opts: OverlayOptions = {}) {
        this.domain = opts.domain ?? 'workspace';
        this.home = opts.home;
        this.audit = opts.audit;
    }

    get lifetime(): DerivedLabel['lifetime'] {
        return this.domain === 'workspace' ? WORKSPACE_LIFETIME : DOMAIN_LIFETIME;
    }

    /**
     * Evaluation point ⑩. `snapshot` defaults to the ledger head; the caller
     * must have committed the current call's own read events first so
     * `fs.copy` cannot move content out from under the overlay (A1a).
     */
    apply(
        target: string,
        ledger: DataflowLedger,
        snapshot?: LedgerSnapshot,
    ): DerivedLabel | undefined {
        const view = snapshot ?? ledger.snapshot();
        const reads = ledger.sensitiveIngestEntries(view);
        if (reads.length === 0) return undefined;

        const normalized = normalizeAssetPath(target, this.home);
        const existing = this.overlays.get(normalized);
        const derivedFrom = [
            ...new Set([...(existing?.derivedFrom ?? []), ...reads.map((r) => r.id)]),
        ];
        const overlay: DerivedLabel = {
            target: normalized,
            label: 'sensitive',
            derivedFrom,
            lifetime: this.lifetime,
            createdAt: view.version,
        };
        this.overlays.set(normalized, overlay);
        this.audit?.log({
            type: 'derived-label-applied',
            target: normalized,
            label: 'sensitive',
            derivedFrom,
            ledgerVersion: view.version,
        });
        return overlay;
    }

    has(target: string): boolean {
        return this.overlays.has(normalizeAssetPath(target, this.home));
    }

    get(target: string): DerivedLabel | undefined {
        return this.overlays.get(normalizeAssetPath(target, this.home));
    }

    /** Overlay labels are capped at sensitive (A1b). */
    labelFor(target: string): 'sensitive' | undefined {
        return this.overlays.has(normalizeAssetPath(target, this.home)) ? 'sensitive' : undefined;
    }

    targets(): string[] {
        return [...this.overlays.keys()];
    }

    /** Explicit per-file clear — an independent first-class security decision (P26). */
    clear(target: string, attestor: string, reason: string): boolean {
        const normalized = normalizeAssetPath(target, this.home);
        if (!this.overlays.delete(normalized)) return false;
        this.audit?.log({ type: 'derived-label-cleared', attestor, target: normalized, reason });
        return true;
    }

    /** sandbox/draft overlays die with the domain. */
    clearByDomainTeardown(): number {
        if (this.domain === 'workspace') return 0;
        const count = this.overlays.size;
        this.overlays.clear();
        return count;
    }

    /**
     * N20/P26: flushing the dataflow ledger does NOT clear the overlay. This
     * method exists to make the decoupling explicit and testable.
     */
    clearOnFlush(): 0 {
        return 0;
    }
}

/**
 * Overlay participation in N15: specificity = ∞, label raised to at most
 * `sensitive`. The returned `fromOverlay` flag tells the value layer that the
 * contribution is flow-only (P24).
 */
export function overlayResolve(
    resolved: ResolvedLabel,
    target: string,
    overlay: DerivedLabelOverlayManager,
): ResolvedLabel {
    if (!overlay.has(target)) return resolved;
    return {
        ...resolved,
        label: maxLabel(resolved.label, 'sensitive'),
        specificity: Number.POSITIVE_INFINITY,
        fromOverlay: true,
    };
}
