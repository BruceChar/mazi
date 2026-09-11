import { describe, expect, it } from 'vitest';

import { AUDIT_GENESIS, DecisionLog, type DecisionLogRecord } from '../src/authz/audit.js';
import { AssetLabelRegistry } from '../src/authz/labels.js';
import {
    Ed25519Signer,
    pinnedHash,
    RevocationRegistry,
    RootTrustAnchor,
} from '../src/authz/root-trust.js';
import { RoleRegistry } from '../src/authz/roles.js';
import { assertSnapshotImmutable, TcbManifest, TCB_SELF_REFERENCE_PATTERNS } from '../src/authz/tcb.js';
import type { PinnedVersions } from '../src/authz/types.js';

describe('AuthorizationV2 root trust (§9.5)', () => {
    it('verifies Ed25519 signatures and rejects tampering', () => {
        const signer = Ed25519Signer.generate('root-1');
        const anchor = new RootTrustAnchor();
        anchor.register(signer, 1);
        const signature = signer.sign('payload');
        expect(anchor.verify('root-1', 'payload', signature)).toBe(true);
        expect(anchor.verify('root-1', 'other', signature)).toBe(false);
        expect(anchor.verify('missing', 'payload', signature)).toBe(false);
    });

    it('supports key rotation with versioned verification', () => {
        const first = Ed25519Signer.generate('root-1');
        const second = Ed25519Signer.generate('root-2');
        const anchor = new RootTrustAnchor();
        anchor.register(first, 1);
        const firstSignature = first.sign('payload');
        anchor.rotate(second, 2, 'root-1');
        const secondSignature = second.sign('payload');

        expect(anchor.version()).toBe(2);
        expect(anchor.verify('root-1', 'payload', firstSignature, 1)).toBe(true);
        expect(anchor.verify('root-1', 'payload', firstSignature, 2)).toBe(false);
        expect(anchor.verify('root-2', 'payload', secondSignature, 2)).toBe(true);
    });

    it('fails closed on revoked snapshots and components', () => {
        const signer = Ed25519Signer.generate('root-1');
        const anchor = new RootTrustAnchor();
        anchor.register(signer, 1);
        const registry = new RevocationRegistry(anchor, signer, () => 42);
        const pinned: PinnedVersions = { labels: 1, roles: 2, rules: 3, rootTrust: 1 };

        expect(registry.isRevoked(pinned)).toBe(false);
        registry.revoke(pinnedHash(pinned), '策略错误');
        expect(registry.isRevoked(pinned)).toBe(true);
        expect(registry.verifyEntry(registry.all()[0])).toBe(true);

        const other: PinnedVersions = { labels: 9, roles: 2, rules: 3, rootTrust: 1 };
        registry.revoke('labels@9', '标注错误');
        expect(registry.isRevoked(other)).toBe(true);
    });
});

describe('AuthorizationV2 audit chain (§9.5.3)', () => {
    it('appends a signed hash chain that verifies', () => {
        const signer = Ed25519Signer.generate('audit-1');
        const log = new DecisionLog(signer);
        expect(log.head()).toBe(AUDIT_GENESIS);
        log.append({ type: 'ruleHit', rule: 'R1' });
        log.append({ type: 'condition-verdict', verdict: 'broken' });
        expect(log.head()).not.toBe(AUDIT_GENESIS);
        expect(log.verify()).toEqual({ ok: true });
    });

    it('detects a tampered record (AUDIT_TAMPER_SUSPECTED)', () => {
        const signer = Ed25519Signer.generate('audit-1');
        const log = new DecisionLog(signer);
        log.append({ type: 'ruleHit', rule: 'R1' });
        log.append({ type: 'ruleHit', rule: 'R2' });
        const records = log.all() as DecisionLogRecord[];
        records[1].payload = { type: 'ruleHit', rule: 'R6' };
        expect(log.verify()).toMatchObject({ ok: false, code: 'AUDIT_TAMPER_SUSPECTED' });
    });

    it('detects an anchor mismatch', async () => {
        const signer = Ed25519Signer.generate('audit-1');
        const store = new Map<string, string>();
        const anchor = {
            put: (head: string) => {
                store.set('head', head);
            },
            get: () => store.get('head'),
        };
        const log = new DecisionLog(signer, anchor);
        log.append({ type: 'derive-reject' });
        await log.checkpoint();
        expect((await log.verifyAgainstAnchor()).ok).toBe(true);
        store.set('head', 'tampered');
        expect(await log.verifyAgainstAnchor()).toMatchObject({
            ok: false,
            code: 'AUDIT_TAMPER_SUSPECTED',
        });
    });
});

describe('AuthorizationV2 TCB versioning (§9.4)', () => {
    it('pins registry versions and refuses a hot-swapped snapshot', () => {
        const labels = AssetLabelRegistry.builtin();
        const roles = new RoleRegistry({
            'fs.read.workspace': { transfer: 'ingest', commit: 'recoverable', opacity: 'transparent' },
        });
        const manifest = TcbManifest.fromState({
            labels,
            roles,
            rules: { rules: ['R1', 'R2'] },
            rootTrustVersion: 1,
        });
        const pinned = manifest.pinned();
        expect(pinned.labels).toBe(labels.version);
        expect(pinned.roles).toBe(roles.version);
        expect(pinned.rootTrust).toBe(1);

        expect(() => assertSnapshotImmutable(pinned, { ...pinned })).not.toThrow();
        expect(() => assertSnapshotImmutable(pinned, { ...pinned, rules: pinned.rules + 1 })).toThrow();
    });

    it('treats the harness self-envelope as a boundary asset (T2)', () => {
        const registry = AssetLabelRegistry.builtin({ home: '/home/tester' });
        expect(TCB_SELF_REFERENCE_PATTERNS.length).toBeGreaterThan(0);
        const resolved = registry.resolve({ kind: 'path', value: '/home/tester/.mazi/policy.json' });
        expect(resolved.boundary).toBe(true);
    });
});
