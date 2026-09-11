import { describe, expect, it } from 'vitest';

import { DuplicatePaymentGuard } from '../src/authz/approval.js';
import { AuthorizationEngine } from '../src/authz/engine.js';
import { AssetLabelRegistry } from '../src/authz/labels.js';
import { DataflowLedger } from '../src/authz/ledger.js';
import { RoleRegistry } from '../src/authz/roles.js';
import { authorizationWidth } from '../src/authz/telemetry.js';
import type { AgentGrant, BackendCapabilities } from '../src/authz/types.js';

const HOME = '/home/tester';
const WORKSPACE = '/home/tester/work';
const REPORT = `${WORKSPACE}/report.txt`;
const COPY = `${WORKSPACE}/copy.txt`;

const labelRegistry = AssetLabelRegistry.builtin({ home: HOME, workspaceRoot: WORKSPACE });
const roles = new RoleRegistry({
    'fs.read.workspace': { transfer: 'ingest', commit: 'recoverable', opacity: 'transparent' },
    'fs.read.host': { transfer: 'ingest', commit: 'recoverable', opacity: 'transparent' },
    'net.send': { transfer: 'egress', commit: 'recoverable', opacity: 'transparent' },
});
const backend: BackendCapabilities = {
    id: 'test',
    supportsReversibility: ['domain-teardown', 'task-scratch'],
};

function engine(): AuthorizationEngine {
    return new AuthorizationEngine({
        labelRegistry,
        roles,
        backend,
        ledger: new DataflowLedger(),
        pinned: { labels: labelRegistry.version, roles: roles.version, rules: 1, rootTrust: 1 },
        rootContractId: 'root-1',
        rootVersion: 1,
        taskId: 'task-1',
        now: () => 1000,
    });
}

const grant: AgentGrant = {
    'fs.read.workspace': {
        action: 'fs.read',
        domain: 'workspace',
        tier: 'auto',
        maxLabel: 'sensitive',
    },
    'net.send': { action: 'net.send', domain: 'external', tier: 'auto' },
};

describe('AuthorizationV2 end-to-end workstream (§14 walkthrough)', () => {
    it('carries a sensitive read into a workspace artifact and breaks the egress condition', () => {
        const engineUnderTest = engine();
        const derived = engineUnderTest.derive(grant, {
            requires: ['fs.read.workspace', 'net.send'],
        });
        expect(derived.ok).toBe(true);
        if (!derived.ok) return;
        expect(derived.policy.capabilities['net.send'].conditions).toHaveLength(1);
        expect(engineUnderTest.resolveAsset({ kind: 'path', value: REPORT }).label).toBe('internal');

        engineUnderTest.commitRead({
            label: 'sensitive',
            source: 'fs.read.workspace',
            stepId: 's1',
            transferDir: 'ingest',
        });
        expect(engineUnderTest.applyWrite(REPORT)).toBeDefined();

        const report = engineUnderTest.resolveAsset({ kind: 'path', value: REPORT });
        expect(report.label).toBe('sensitive');
        expect(report.fromOverlay).toBe(true);

        expect(engineUnderTest.judgeCondition('net.send')).toBe('broken');
        expect(engineUnderTest.judgeCondition('fs.read.workspace')).toBe('not-applicable');
    });

    it('flush clears the ledger but leaves the overlay in place (N20/P26)', () => {
        const engineUnderTest = engine();
        engineUnderTest.derive(grant, { requires: ['fs.read.workspace', 'net.send'] });
        engineUnderTest.commitRead({
            label: 'sensitive',
            source: 'fs.read.workspace',
            stepId: 's1',
            transferDir: 'ingest',
        });
        engineUnderTest.applyWrite(REPORT);
        engineUnderTest.flush();

        expect(engineUnderTest.judgeCondition('net.send')).toBe('satisfied');
        expect(engineUnderTest.overlay.has(REPORT)).toBe(true);

        expect(engineUnderTest.clearOverlay(REPORT, 'alice', '确认')).toBe(true);
        expect(engineUnderTest.resolveAsset({ kind: 'path', value: REPORT }).label).toBe('internal');
    });

    it('A1a: a severed secret read produces no overlay', () => {
        const engineUnderTest = engine();
        engineUnderTest.commitRead({
            label: 'secret',
            source: 'fs.read.host',
            stepId: 's1',
            transferDir: 'ingest',
            severed: true,
        });
        expect(engineUnderTest.applyWrite(COPY)).toBeUndefined();
    });

    it('A2a: a new sensitive read invalidates a generation-level attestation synchronously', () => {
        const engineUnderTest = engine();
        engineUnderTest.commitRead({
            label: 'sensitive',
            source: 'fs.read.workspace',
            stepId: 's1',
            transferDir: 'ingest',
        });
        const attestation = engineUnderTest.attestEgress('alice', 'generation-egress');
        expect(engineUnderTest.isAttestationValid(attestation)).toBe(true);

        engineUnderTest.commitRead({
            label: 'sensitive',
            source: 'fs.read.workspace',
            stepId: 's2',
            transferDir: 'ingest',
        });
        expect(engineUnderTest.isAttestationValid(attestation)).toBe(false);
    });
});

describe('AuthorizationV2 supporting governance', () => {
    it('measures authorization width for root review (T7)', () => {
        const width = authorizationWidth(grant);
        expect(width.capabilities).toBe(2);
        expect(width.maxLabelDistribution.sensitive).toBe(1);
    });

    it('forces re-confirmation on a duplicate charge (V18/§8.2)', () => {
        const guard = new DuplicatePaymentGuard(5 * 60 * 1000);
        const amount = { currency: 'USD', amount: 50 };
        expect(guard.observe('acme', amount, 1000)).toBe(false);
        expect(guard.observe('acme', amount, 2000)).toBe(true);
        expect(guard.observe('acme', amount, 400_000)).toBe(false);
    });

    it('flags a conservative re-read after version advancement (N8)', () => {
        const ledger = new DataflowLedger();
        ledger.commit(ledger.beginWrite(), {
            label: 'internal',
            source: 'fs.write',
            stepId: 's1',
            transferDir: 'none',
        });
        expect(ledger.recheck(0)).toMatchObject({ advanced: true, requested: 0 });
        expect(ledger.recheck(1).advanced).toBe(false);
    });
});
