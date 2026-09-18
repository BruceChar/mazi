import { describe, expect, it } from 'vitest';

import { DecisionLog, Ed25519Signer } from '../src/authz/trust.js';

describe('authz trust', () => {
    it('signs and verifies with Ed25519', () => {
        const signer = Ed25519Signer.generate('root-1');
        const signature = signer.sign('payload');
        expect(signer.verify('payload', signature)).toBe(true);
        expect(signer.verify('other', signature)).toBe(false);
    });

    it('verifies an untampered append-only chain', () => {
        const log = new DecisionLog(Ed25519Signer.generate());
        log.append({ type: 'policy.check' });
        log.append({ type: 'approval.granted' });
        expect(log.verify()).toEqual({ ok: true });
    });

    it('detects a tampered record', () => {
        const log = new DecisionLog(Ed25519Signer.generate());
        log.append({ type: 'policy.check' });
        (log.all()[0]!.payload as { type: string }).type = 'forged';
        expect(log.verify()).toMatchObject({ ok: false, code: 'AUDIT_TAMPER_SUSPECTED' });
    });

    it('detects an anchor mismatch', async () => {
        let anchored: string | undefined = 'genesis';
        const log = new DecisionLog(Ed25519Signer.generate(), {
            put: (head) => {
                anchored = head;
            },
            get: () => anchored,
        });
        log.append({ type: 'policy.check' });
        expect((await log.verifyAgainstAnchor()).ok).toBe(false);
        await log.checkpoint();
        expect((await log.verifyAgainstAnchor()).ok).toBe(true);
    });
});
