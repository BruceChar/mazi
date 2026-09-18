import { describe, expect, it } from 'vitest';

import { DataflowLedger, TaintTable } from '../src/authz/ledger.js';

describe('authz dataflow ledger', () => {
    it('commits at a monotonic version and exposes a prefix snapshot', () => {
        const ledger = new DataflowLedger();
        expect(ledger.commit({ label: 'internal', source: 'a', stepId: 's1' })).toBe(1);
        expect(ledger.commit({ label: 'sensitive', source: 'b', stepId: 's2' })).toBe(2);
        expect(ledger.snapshot(1).entries).toHaveLength(1);
        expect(ledger.snapshot().entries).toHaveLength(2);
    });

    it('adjudicates egress as broken once an unsevered sensitive read is committed', () => {
        const ledger = new DataflowLedger();
        expect(ledger.adjudicate().broken).toBe(false);
        ledger.commit({ label: 'sensitive', source: 'db.read', stepId: 's1' });
        const verdict = ledger.adjudicate();
        expect(verdict.broken).toBe(true);
        expect(verdict.sources).toEqual(['db.read']);
    });

    it('does not break egress for a severed secret read', () => {
        const ledger = new DataflowLedger();
        ledger.commit({ label: 'secret', source: 'fs.read.host', stepId: 's1', severed: true });
        expect(ledger.adjudicate().broken).toBe(false);
    });

    it('reports a newer commit after adjudication (INV-B)', () => {
        const ledger = new DataflowLedger();
        const version = ledger.commit({ label: 'internal', source: 'a', stepId: 's1' });
        expect(ledger.recheck(version)).toBe(false);
        ledger.commit({ label: 'internal', source: 'b', stepId: 's2' });
        expect(ledger.recheck(version)).toBe(true);
    });

    it('inherits the ledger on compaction but clears it on user reset', () => {
        const ledger = new DataflowLedger();
        ledger.commit({ label: 'sensitive', source: 'db.read', stepId: 's1' });
        ledger.switchPeriod('auto-compaction');
        expect(ledger.adjudicate().broken).toBe(true);
        ledger.switchPeriod('user-reset');
        expect(ledger.adjudicate().broken).toBe(false);
    });

    it('honors minimal-deployment summary inheritance', () => {
        const ledger = new DataflowLedger();
        ledger.commit({ label: 'sensitive', source: 'db.read', stepId: 's1' });
        ledger.switchPeriod('auto-compaction', 'summary');
        const verdict = ledger.adjudicate();
        expect(verdict.broken).toBe(true);
        expect(verdict.sources).toEqual(['inherited-summary']);
    });

    it('records projection columns', () => {
        const ledger = new DataflowLedger();
        ledger.commit({
            label: 'sensitive',
            source: 'db.read',
            stepId: 's1',
            columns: ['email'],
        });
        expect(ledger.snapshot().entries[0]?.columns).toEqual(['email']);
    });
});

describe('authz residue taint', () => {
    it('taints a written file while the ledger holds an unsevered sensitive read', () => {
        const ledger = new DataflowLedger();
        const taint = new TaintTable();
        expect(taint.markFromLedger('/w/report.txt', ledger)).toBe(false);
        ledger.commit({ label: 'sensitive', source: 'db.read', stepId: 's1' });
        expect(taint.markFromLedger('/w/report.txt', ledger)).toBe(true);
        expect(taint.has('/w/report.txt')).toBe(true);
        expect(taint.labelFor('/w/report.txt')).toBe('sensitive');
    });

    it('decouples taint clearing from ledger reset', () => {
        const ledger = new DataflowLedger();
        const taint = new TaintTable();
        ledger.commit({ label: 'sensitive', source: 'db.read', stepId: 's1' });
        taint.markFromLedger('/w/report.txt', ledger);
        ledger.switchPeriod('user-reset');
        expect(taint.has('/w/report.txt')).toBe(true);
        expect(taint.clear('/w/report.txt', 'user', 'reviewed')).toBe(true);
        expect(taint.has('/w/report.txt')).toBe(false);
    });
});
