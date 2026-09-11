import { describe, expect, it } from 'vitest';

import { contentVersion } from '../src/authz/hash.js';
import {
    constructWire,
    guardGenericEgress,
    type HandleAuditEvent,
    normalizeTarget,
    type ResolverDeps,
    SecretRefResolver,
    selectParseLevel,
    TokenRevocationList,
    type SecretRef,
} from '../src/authz/secret-ref.js';

function collector(): {
    audit: { log(e: HandleAuditEvent): void };
    events: HandleAuditEvent[];
} {
    const events: HandleAuditEvent[] = [];
    return { audit: { log: (e) => events.push(e) }, events };
}

const baseRef: SecretRef = {
    refId: 'ref:s3',
    label: 'secret',
    allowedSinks: ['aws.s3'],
    purpose: {
        service: 's3',
        actions: ['GetObject', 'ListBucket'],
        resourcePattern: 'arn:aws:s3:::my-bucket/*',
        conditions: { maxBodyBytes: 64, allowedHeaders: ['content-type'], maxTTL: 30_000 },
    },
    parseLevel: 'L1',
    credentialId: 'cred:aws',
};

function deps(overrides: Partial<ResolverDeps> = {}): ResolverDeps & {
    events: HandleAuditEvent[];
} {
    const { audit, events } = collector();
    return {
        sign: (payload, keyId) => `sig:${keyId}:${contentVersion(payload).toString(16)}`,
        audit,
        toolMaxParseLevel: () => 'L1',
        now: () => 1000,
        revocation: new TokenRevocationList(),
        ...overrides,
        events,
    };
}

const validInvocation = {
    tool: 'aws.s3',
    service: 's3',
    action: 'GetObject',
    target: 'arn:aws:s3:::my-bucket/dir/key.txt',
    body: 'hello',
    headers: { 'content-type': 'text/plain' },
};

describe('AuthorizationV2 SecretRef parse-level selection', () => {
    it('never degrades an L1-capable ref to L3 because of a weaker tool', () => {
        expect(selectParseLevel('L1', 'L1')).toBe('L1');
        expect(selectParseLevel('L1', 'L3')).toBe('L3');
        expect(selectParseLevel('L2', 'L1')).toBe('L2');
    });
});

describe('AuthorizationV2 L1 gateway signing (N12/N16)', () => {
    it('signs a policy-valid structured invocation and constructs the wire', () => {
        const d = deps();
        const outcome = new SecretRefResolver(d).resolve(baseRef, validInvocation);
        expect(outcome.kind).toBe('signed');
        if (outcome.kind !== 'signed') return;
        expect(outcome.signed.resource).toBe('arn:aws:s3:::my-bucket/dir/key.txt');
        expect(outcome.signed.wire).toContain('arn:aws:s3:::my-bucket/dir/key.txt');
        expect(outcome.signed.signature).toContain('sig:cred:aws');
        expect(d.events.map((e) => e.type)).toContain('sign-policy-passed');
    });

    it('refuses a tool outside allowedSinks', () => {
        const d = deps();
        const outcome = new SecretRefResolver(d).resolve(baseRef, {
            ...validInvocation,
            tool: 'evil.tool',
        });
        expect(outcome).toMatchObject({ kind: 'rejected', code: 'HANDLE_REFUSED' });
        expect(d.events.map((e) => e.type)).toContain('handle-refused');
    });

    it('enforces service x action x resource', () => {
        const resolver = new SecretRefResolver(deps());
        expect(resolver.resolve(baseRef, { ...validInvocation, service: 'ec2' })).toMatchObject({
            code: 'SIGN_POLICY_VIOLATION',
        });
        expect(
            resolver.resolve(baseRef, { ...validInvocation, action: 'DeleteObject' }),
        ).toMatchObject({ code: 'SIGN_POLICY_VIOLATION' });
        expect(
            resolver.resolve(baseRef, {
                ...validInvocation,
                target: 'arn:aws:s3:::other-bucket/key.txt',
            }),
        ).toMatchObject({ code: 'SIGN_POLICY_VIOLATION' });
    });

    it('closes the canonical-form attack via TCB normalization (P21)', () => {
        const resolver = new SecretRefResolver(deps());
        const attack = resolver.resolve(baseRef, {
            ...validInvocation,
            target: 'arn:aws:s3:::my-bucket/../other-bucket/key.txt',
        });
        expect(attack).toMatchObject({ kind: 'rejected', code: 'SIGN_POLICY_VIOLATION' });
        expect(normalizeTarget('arn:aws:s3:::my-bucket/../other-bucket/key.txt')).toBe(
            'other-bucket/key.txt',
        );
    });

    it('rejects oversized bodies and disallowed headers', () => {
        const resolver = new SecretRefResolver(deps());
        expect(
            resolver.resolve(baseRef, { ...validInvocation, body: 'x'.repeat(65) }),
        ).toMatchObject({ code: 'SIGN_POLICY_VIOLATION' });
        expect(
            resolver.resolve(baseRef, {
                ...validInvocation,
                headers: { 'x-evil': '1' },
            }),
        ).toMatchObject({ code: 'SIGN_POLICY_VIOLATION' });
    });

    it('enforces maxUses replay limits', () => {
        const ref: SecretRef = {
            ...baseRef,
            refId: 'ref:replay',
            purpose: {
                ...baseRef.purpose,
                conditions: { ...baseRef.purpose.conditions, maxUses: 2 },
            },
        };
        const d = deps();
        const resolver = new SecretRefResolver(d);
        expect(resolver.resolve(ref, validInvocation).kind).toBe('signed');
        expect(resolver.resolve(ref, validInvocation).kind).toBe('signed');
        expect(resolver.resolve(ref, validInvocation)).toMatchObject({
            code: 'SIGN_MAX_USES_EXCEEDED',
        });
        expect(d.events.map((e) => e.type)).toContain('sign-max-uses-exceeded');
    });

    it('constructs the wire deterministically inside the TCB', () => {
        const wire = constructWire(baseRef, validInvocation, 'arn:aws:s3:::my-bucket/dir/key.txt');
        expect(wire).toContain('"service":"s3"');
        expect(wire).toContain('"action":"GetObject"');
        expect(wire).toContain('"target":"arn:aws:s3:::my-bucket/dir/key.txt"');
    });
});

describe('AuthorizationV2 L2 capability tokens and L3 injection', () => {
    it('issues a short-TTL revocable token for an L2 sink', () => {
        const d = deps({ toolMaxParseLevel: () => 'L2' });
        const ref: SecretRef = { ...baseRef, parseLevel: 'L2' };
        const outcome = new SecretRefResolver(d).resolve(ref, validInvocation);
        expect(outcome.kind).toBe('token');
        if (outcome.kind !== 'token') return;
        expect(outcome.token.expiresAt - outcome.token.issuedAt).toBeLessThanOrEqual(60_000);

        const resolver = new SecretRefResolver(d);
        expect(resolver.verifyToken(outcome.token)).toBe(true);
        resolver.revokeToken(outcome.token);
        expect(resolver.verifyToken(outcome.token)).toBe(false);
        expect(d.events.map((e) => e.type)).toContain('token-issued');
    });

    it('requires a root-signed L3 exception', () => {
        const deny = deps({ toolMaxParseLevel: () => 'L3' });
        const ref: SecretRef = { ...baseRef, parseLevel: 'L3' };
        expect(new SecretRefResolver(deny).resolve(ref, validInvocation)).toMatchObject({
            code: 'HANDLE_REFUSED',
        });

        const allow = deps({ toolMaxParseLevel: () => 'L3' });
        const granted: SecretRef = { ...ref, l3Exception: true };
        const outcome = new SecretRefResolver(allow).resolve(granted, validInvocation);
        expect(outcome.kind).toBe('injected');
        expect(allow.events.map((e) => e.type)).toContain('handle-inject-origin');
    });
});

describe('AuthorizationV2 generic egress handle opacity (N4)', () => {
    it('rejects args handles by default and records an audit event', () => {
        const { audit, events } = collector();
        const result = guardGenericEgress({ body: 'secretref:ref:s3' }, { audit });
        expect(result).toMatchObject({ kind: 'rejected', code: 'HANDLE_UNRESOLVABLE' });
        expect(events[0].type).toBe('handle-refused');
    });

    it('passes handles through as opaque data when configured', () => {
        const { audit } = collector();
        const result = guardGenericEgress({ nested: { body: 'secretref:ref:s3' } }, {
            audit,
            mode: 'passthrough',
        });
        expect(result.kind).toBe('passthrough');
        expect(result.handles).toEqual(['secretref:ref:s3']);
    });
});
