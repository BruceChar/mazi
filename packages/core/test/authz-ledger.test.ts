import { describe, expect, it } from 'vitest';

import {
    buildAttestationText,
    DataflowLedger,
    evaluateNoSensitiveIngest,
    isAttestationValid,
    LedgerBarrierTimeoutError,
    makeAttestation,
    type LedgerAuditEvent,
} from '../src/authz/ledger.js';

function collector(): { audit: { log(e: LedgerAuditEvent): void }; events: LedgerAuditEvent[] } {
    const events: LedgerAuditEvent[] = [];
    return { audit: { log: (e) => events.push(e) }, events };
}

describe('AuthorizationV2 dataflow ledger', () => {
    it('assigns a monotonic version at the commit point', () => {
        const ledger = new DataflowLedger();
        const a = ledger.beginWrite();
        const v1 = ledger.commit(a, {
            label: 'internal',
            source: 'fs.write',
            stepId: 's1',
            transferDir: 'none',
        });
        const b = ledger.beginWrite();
        const v2 = ledger.commit(b, {
            label: 'sensitive',
            source: 'fs.read',
            stepId: 's2',
            transferDir: 'ingest',
        });
        expect(v1).toBe(1);
        expect(v2).toBe(2);
        expect(ledger.snapshot(1).entries).toHaveLength(1);
        expect(ledger.snapshot(1).version).toBe(1);
    });

    it('barrier waits for in-flight writes to commit', async () => {
        const ledger = new DataflowLedger();
        const handle = ledger.beginWrite();
        setTimeout(() => {
            ledger.commit(handle, {
                label: 'sensitive',
                source: 'fs.read',
                stepId: 's1',
                transferDir: 'ingest',
            });
        }, 10);
        const snapshot = await ledger.barrier(1000);
        expect(snapshot.version).toBe(1);
        expect(evaluateNoSensitiveIngest(snapshot)).toBe('broken');
    });

    it('fails closed when the barrier times out (LEDGER_BARRIER_TIMEOUT)', async () => {
        const ledger = new DataflowLedger();
        ledger.beginWrite();
        await expect(ledger.barrier(5)).rejects.toBeInstanceOf(LedgerBarrierTimeoutError);
        await expect(ledger.barrier(5)).rejects.toMatchObject({
            code: 'LEDGER_BARRIER_TIMEOUT',
        });
    });

    it('auto-compaction inherits the unsevered sensitive event set (N11)', () => {
        const { audit } = collector();
        const ledger = new DataflowLedger({ audit });
        ledger.commit(ledger.beginWrite(), {
            label: 'sensitive',
            source: 'fs.read',
            stepId: 's1',
            transferDir: 'ingest',
        });
        ledger.commit(ledger.beginWrite(), {
            label: 'secret',
            source: 'fs.read',
            stepId: 's2',
            transferDir: 'ingest',
            severed: true,
        });
        const inherited = ledger.switchGeneration('auto-compaction', 'full');
        expect(inherited.entries).toHaveLength(2);
        expect(evaluateNoSensitiveIngest(inherited)).toBe('broken');
    });

    it('boolean-summary inheritance keeps the flag without attribution (minimal deployment)', () => {
        const ledger = new DataflowLedger();
        ledger.commit(ledger.beginWrite(), {
            label: 'sensitive',
            source: 'fs.read',
            stepId: 's1',
            transferDir: 'ingest',
        });
        const inherited = ledger.switchGeneration('auto-compaction', 'summary');
        expect(inherited.entries).toHaveLength(1);
        expect(inherited.entries[0].source).toBe('inherited-summary');
        expect(evaluateNoSensitiveIngest(inherited)).toBe('broken');
    });

    it('only an explicit user flush clears the ledger', () => {
        const ledger = new DataflowLedger();
        ledger.commit(ledger.beginWrite(), {
            label: 'sensitive',
            source: 'fs.read',
            stepId: 's1',
            transferDir: 'ingest',
        });
        expect(ledger.hasSensitiveIngest()).toBe(true);
        const cleared = ledger.switchGeneration('user');
        expect(cleared.entries).toHaveLength(0);
        expect(ledger.hasSensitiveIngest()).toBe(false);
    });

    it('emits generation-switch audit events with the right reason', () => {
        const { audit, events } = collector();
        const ledger = new DataflowLedger({ audit });
        ledger.switchGeneration('user');
        ledger.switchGeneration('auto-compaction', 'full');
        ledger.switchGeneration('context-destroyed');
        const switches = events.filter((e) => e.type === 'generation-switch');
        expect(switches.map((e) => (e.type === 'generation-switch' ? e.reason : ''))).toEqual([
            'session-created',
            'user',
            'auto-compaction',
            'context-destroyed',
        ]);
        expect(switches[1]).toMatchObject({ cleared: true });
        expect(switches[2]).toMatchObject({ inherited: 'full' });
        expect(switches[3]).toMatchObject({ archived: true });
    });

    it('treats a missing ledger snapshot as broken (N5 fail-safe)', () => {
        expect(evaluateNoSensitiveIngest(undefined)).toBe('broken');
    });

    it('A2a: attestation validity is computed synchronously against the version prefix', () => {
        const ledger = new DataflowLedger();
        ledger.commit(ledger.beginWrite(), {
            label: 'sensitive',
            source: 'fs.read',
            stepId: 's1',
            transferDir: 'ingest',
        });
        const attestation = makeAttestation('alice', 'egress', ledger.snapshot(), 1000);
        expect(isAttestationValid(attestation, ledger.snapshot())).toBe(true);

        ledger.commit(ledger.beginWrite(), {
            label: 'sensitive',
            source: 'fs.read',
            stepId: 's2',
            transferDir: 'ingest',
        });
        expect(isAttestationValid(attestation, ledger.snapshot())).toBe(false);
    });

    it('A2b: attestation text discloses counts, sources and derived-label files', () => {
        const ledger = new DataflowLedger();
        ledger.commit(ledger.beginWrite(), {
            label: 'sensitive',
            source: 'db.read',
            stepId: 's1',
            transferDir: 'ingest',
        });
        const text = buildAttestationText(ledger.snapshot(), ['/home/tester/work/report.txt']);
        expect(text).toContain('1 次 sensitive 读');
        expect(text).toContain('db.read');
        expect(text).toContain('1 个 derived-label 文件');
        expect(text).toContain('签署后本世代 egress 将静默');
    });
});
