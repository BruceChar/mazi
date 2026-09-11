import { describe, expect, it } from 'vitest';

import { AssetLabelRegistry } from '../src/authz/labels.js';
import { DataflowLedger } from '../src/authz/ledger.js';
import {
    DerivedLabelOverlayManager,
    overlayResolve,
    type OverlayAuditEvent,
} from '../src/authz/overlay.js';

const HOME = '/home/tester';
const WORKSPACE = '/home/tester/work';
const REPORT = `${WORKSPACE}/report.txt`;
const COPY = `${WORKSPACE}/copy.txt`;

function collector(): { audit: { log(e: OverlayAuditEvent): void }; events: OverlayAuditEvent[] } {
    const events: OverlayAuditEvent[] = [];
    return { audit: { log: (e) => events.push(e) }, events };
}

function write(ledger: DataflowLedger, label: 'sensitive' | 'secret', severed: boolean): void {
    ledger.commit(ledger.beginWrite(), {
        label,
        source: 'fs.read',
        stepId: 's1',
        transferDir: 'ingest',
        severed,
    });
}

describe('AuthorizationV2 derived label overlay', () => {
    it('A1a: severed reads do not produce overlay, unsevered sensitive reads do', () => {
        const ledger = new DataflowLedger();
        const overlay = new DerivedLabelOverlayManager({ home: HOME });
        write(ledger, 'secret', true);
        expect(overlay.apply(REPORT, ledger)).toBeUndefined();

        write(ledger, 'sensitive', false);
        expect(overlay.apply(REPORT, ledger)).toBeDefined();
        expect(overlay.labelFor(REPORT)).toBe('sensitive');
    });

    it('A1a: the evaluation point includes the current call own read (copy move escape)', () => {
        const ledger = new DataflowLedger();
        const overlay = new DerivedLabelOverlayManager({ home: HOME });
        // fs.copy(report.txt -> copy.txt): the source read is committed first.
        write(ledger, 'sensitive', false);
        overlay.apply(COPY, ledger);
        expect(overlay.has(COPY)).toBe(true);
    });

    it('A1b: overlay labels are capped at sensitive even for a secret read event', () => {
        const ledger = new DataflowLedger();
        const overlay = new DerivedLabelOverlayManager({ home: HOME });
        write(ledger, 'secret', false);
        const derived = overlay.apply(REPORT, ledger);
        expect(derived?.label).toBe('sensitive');
    });

    it('A1b: overlay raises the flow label but keeps a static secret secret', () => {
        const registry = AssetLabelRegistry.builtin({ home: HOME, workspaceRoot: WORKSPACE });
        const ledger = new DataflowLedger();
        const overlay = new DerivedLabelOverlayManager({ home: HOME });
        write(ledger, 'sensitive', false);
        overlay.apply(REPORT, ledger);

        const internal = registry.resolve({ kind: 'path', value: REPORT });
        const resolved = overlayResolve(internal, REPORT, overlay);
        expect(internal.label).toBe('internal');
        expect(resolved.label).toBe('sensitive');
        expect(resolved.fromOverlay).toBe(true);
        expect(resolved.specificity).toBe(Number.POSITIVE_INFINITY);

        const staticSecret = registry.resolve({ kind: 'path', value: `${HOME}/.ssh/id_rsa` });
        expect(overlayResolve(staticSecret, `${HOME}/.ssh/id_rsa`, overlay).label).toBe('secret');
    });

    it('A1c: workspace overlays survive session end; sandbox overlays die with the domain', () => {
        const ledger = new DataflowLedger();
        write(ledger, 'sensitive', false);

        const workspace = new DerivedLabelOverlayManager({ domain: 'workspace', home: HOME });
        workspace.apply(REPORT, ledger);
        expect(workspace.clearByDomainTeardown()).toBe(0);
        expect(workspace.has(REPORT)).toBe(true);

        const sandbox = new DerivedLabelOverlayManager({ domain: 'sandbox', home: HOME });
        sandbox.apply(REPORT, ledger);
        expect(sandbox.lifetime).toBe('sandbox-teardown');
        expect(sandbox.clearByDomainTeardown()).toBe(1);
        expect(sandbox.has(REPORT)).toBe(false);
    });

    it('N20/P26: flush does not clear the overlay; explicit per-file clear does', () => {
        const { audit, events } = collector();
        const ledger = new DataflowLedger();
        write(ledger, 'sensitive', false);
        const overlay = new DerivedLabelOverlayManager({ domain: 'workspace', home: HOME, audit });
        overlay.apply(REPORT, ledger);

        expect(overlay.clearOnFlush()).toBe(0);
        expect(overlay.has(REPORT)).toBe(true);

        expect(overlay.clear(REPORT, 'alice', '用户确认')).toBe(true);
        expect(overlay.has(REPORT)).toBe(false);
        expect(events).toContainEqual({
            type: 'derived-label-cleared',
            attestor: 'alice',
            target: REPORT,
            reason: '用户确认',
        });
    });

    it('emits derived-label-applied with the source event ids', () => {
        const { audit, events } = collector();
        const ledger = new DataflowLedger();
        write(ledger, 'sensitive', false);
        const overlay = new DerivedLabelOverlayManager({ home: HOME, audit });
        const derived = overlay.apply(REPORT, ledger);
        expect(derived?.derivedFrom).toEqual(['gen-1:1']);
        expect(events[0]).toMatchObject({ type: 'derived-label-applied', ledgerVersion: 1 });
    });
});
