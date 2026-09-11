import { describe, expect, it } from 'vitest';

import {
    APPROVAL_TOKEN_TTL_MS,
    hashEcho,
    issueApprovalToken,
    requiresDualApproval,
    summarizeEcho,
    verifyApprovalToken,
    type ApprovalEcho,
} from '../src/authz/approval.js';
import { Ed25519Signer } from '../src/authz/root-trust.js';
import {
    assessStability,
    klDivergence,
    signatureOf,
    TrustLadder,
    type BehaviorSignature,
} from '../src/authz/trust-ladder.js';
import { isDangerVerb, matchVerb, strongestVerb } from '../src/authz/verbs.js';

describe('AuthorizationV2 verb matcher (§7.1)', () => {
    it('re-roles rm and DROP as committed', () => {
        expect(matchVerb('rm -rf src/')).toEqual([
            expect.objectContaining({ action: 'delete', commit: 'committed' }),
        ]);
        expect(matchVerb('DROP TABLE users')).toEqual([
            expect.objectContaining({ action: 'ddl', commit: 'committed' }),
        ]);
    });

    it('detects force-push, dd and DELETE without WHERE', () => {
        expect(isDangerVerb('git push --force origin main')).toBe(true);
        expect(isDangerVerb('dd if=/dev/zero of=/dev/sda')).toBe(true);
        expect(isDangerVerb('DELETE FROM users')).toBe(true);
        expect(isDangerVerb('DELETE FROM users WHERE id = 1')).toBe(false);
    });

    it('returns no match for benign commands', () => {
        expect(matchVerb('ls -la')).toEqual([]);
        expect(strongestVerb([])).toBeUndefined();
    });
});

describe('AuthorizationV2 approval contract (V18/T8)', () => {
    const echo: ApprovalEcho = {
        invocationId: 'inv-1',
        tool: 'charge',
        effectClass: 'pay.external',
        targetAsset: 'merchant:acme',
        counterparty: 'Acme Inc.',
        amount: { currency: 'USD', amount: 50 },
        dataflowSources: ['db.read'],
        derivedLabelProvenance: ['/home/tester/work/report.txt'],
    };

    it('binds a short-lived token to invocationId + summary hash', () => {
        const signer = Ed25519Signer.generate('approver-1');
        const token = issueApprovalToken(echo, 'alice', signer, 1000);
        expect(token.expiresAt - token.issuedAt).toBeLessThanOrEqual(APPROVAL_TOKEN_TTL_MS);
        expect(verifyApprovalToken(token, echo, signer, 1000)).toBe(true);
        expect(verifyApprovalToken(token, echo, signer, 1000 + APPROVAL_TOKEN_TTL_MS)).toBe(false);
        expect(
            verifyApprovalToken(token, { ...echo, targetAsset: 'other' }, signer, 1000),
        ).toBe(false);
    });

    it('generates a summary naming the concrete transaction', () => {
        const summary = summarizeEcho(echo);
        expect(summary).toContain('Acme Inc.');
        expect(summary).toContain('50 USD');
        expect(summary).toContain('数据流来源：db.read');
        expect(summary).toContain('数据残留来源');
        expect(hashEcho(echo)).toBe(hashEcho({ ...echo }));
    });

    it('requires two-person sign-off for high-risk operations', () => {
        expect(requiresDualApproval('pay-over-limit')).toBe(true);
        expect(requiresDualApproval('boundary-write')).toBe(true);
        expect(requiresDualApproval('l3-exception')).toBe(true);
        expect(requiresDualApproval('secret-downgrade')).toBe(true);
        expect(requiresDualApproval('boundary-write', { rootDowngrade: true })).toBe(false);
    });
});

describe('AuthorizationV2 trust ladder (§4.6/N6)', () => {
    const baseSignature: BehaviorSignature = signatureOf({
        domain: 'external',
        effectClass: 'net.fetch',
        target: 'api.example.com/v1',
        args: { url: 'x' },
        transferDir: 'ingest',
        frequency: 5,
        verdictPath: 'auto',
    });

    it('only promotes with a root signature and falls back to T0 on version change', () => {
        const ladder = new TrustLadder();
        ladder.register('mcp.srv', '1.0');
        expect(ladder.tierOf('mcp.srv')).toBe('T0');
        expect(() => ladder.promote('mcp.srv', 'T1', false)).toThrow();
        ladder.promote('mcp.srv', 'T1', true);
        expect(ladder.r4Effect('mcp.srv').floor).toBe('declared-role');

        ladder.onVersionChange('mcp.srv', '2.0');
        expect(ladder.tierOf('mcp.srv')).toBe('T0');
    });

    it('demotes immediately on a danger event', () => {
        const ladder = new TrustLadder();
        ladder.register('mcp.srv', '1.0');
        ladder.promote('mcp.srv', 'T1', true);
        ladder.recordCall('mcp.srv', baseSignature, { danger: true });
        expect(ladder.evaluate('mcp.srv')).toMatchObject({ tier: 'T0', demoted: true });
    });

    it('uses set comparison during the small-sample period', () => {
        const ladder = new TrustLadder();
        ladder.register('mcp.srv', '1.0');
        ladder.promote('mcp.srv', 'T1', true);
        ladder.recordCall('mcp.srv', baseSignature);
        ladder.commitBaseline('mcp.srv');
        const drifted = signatureOf({
            domain: 'external',
            effectClass: 'net.fetch',
            target: 'evil.example.com/v1',
            args: { url: 'x' },
            transferDir: 'ingest',
            frequency: 5,
            verdictPath: 'auto',
        });
        ladder.recordCall('mcp.srv', drifted);
        const report = ladder.evaluate('mcp.srv');
        expect(report.demoted).toBe(true);
        expect(report.report.mode).toBe('set');
    });

    it('uses KL divergence once the window is large enough', () => {
        const ladder = new TrustLadder();
        ladder.register('mcp.srv', '1.0');
        for (let i = 0; i < 250; i += 1) ladder.recordCall('mcp.srv', baseSignature);
        ladder.commitBaseline('mcp.srv');
        ladder.promote('mcp.srv', 'T1', true);
        for (let i = 0; i < 250; i += 1) ladder.recordCall('mcp.srv', baseSignature);
        expect(assessStability({ calls: [baseSignature], dangerEvents: 0 }, [baseSignature]).stable).toBe(true);
        expect(klDivergence([baseSignature], [baseSignature])).toBeLessThan(1e-3);

        const drifted = signatureOf({
            domain: 'external',
            effectClass: 'pay',
            target: 'evil.example.com/v1',
            args: { amount: 100 },
            transferDir: 'egress',
            frequency: 5,
            verdictPath: 'gated',
        });
        for (let i = 0; i < 250; i += 1) ladder.recordCall('mcp.srv', drifted);
        const report = ladder.evaluate('mcp.srv');
        expect(report.demoted).toBe(true);
        expect(report.report.mode).toBe('distribution');
    });
});
