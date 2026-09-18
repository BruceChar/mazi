import { describe, expect, it } from 'vitest';

import {
    assertCurated,
    computeAttributes,
    guardGenericEgress,
    HANDLE_PREFIX,
    SecretService,
} from '../src/authz/secret.js';

const PURPOSE = {
    service: 's3',
    actions: ['GetObject'],
    resourcePattern: 'arn:aws:s3:::bucket/*',
};
const MATERIAL = 'AKIAIOSFODNN7EXAMPLE';

function service(): SecretService {
    return new SecretService({
        sign: (payload, material) => `sig:${material.length}:${payload.length}`,
    });
}

describe('authz secret severance', () => {
    it('rejects attribute kinds outside the curated set (INV-C)', () => {
        expect(() => assertCurated(['kind', 'raw-bytes' as never])).toThrow('非策展属性');
    });

    it('computes only the requested curated attributes', () => {
        const attributes = computeAttributes(MATERIAL, ['kind', 'prefix-class', 'validity']);
        expect(attributes).toEqual({
            kind: 'api-key',
            prefixClass: 'AKIA',
            validity: 'format-ok',
        });
        expect(attributes.lengthBucket).toBeUndefined();
    });

    it('sever returns a voucher and attributes, never the plaintext', () => {
        const severed = service().sever({
            refId: 'ref-1',
            allowedSinks: ['net.send'],
            purpose: PURPOSE,
            value: MATERIAL,
            profile: { pattern: '**/.env*', attributes: ['kind', 'validity'] },
        });
        expect(severed.handle).toBe(`${HANDLE_PREFIX}ref-1`);
        expect(severed.attributes).toEqual({ kind: 'api-key', validity: 'format-ok' });
        expect(JSON.stringify(severed)).not.toContain(MATERIAL);
    });
});

describe('authz gateway signer', () => {
    it('refuses a tool outside allowedSinks', () => {
        const svc = service();
        svc.sever({ refId: 'r', allowedSinks: ['net.send'], purpose: PURPOSE, value: MATERIAL });
        const outcome = svc.resolve('r', 'net.fetch', {
            tool: 'net.fetch',
            service: 's3',
            action: 'GetObject',
            target: 'arn:aws:s3:::bucket/a',
        });
        expect(outcome).toMatchObject({ kind: 'rejected', code: 'HANDLE_REFUSED' });
    });

    it('refuses an invocation that violates the purpose', () => {
        const svc = service();
        svc.sever({ refId: 'r', allowedSinks: ['net.send'], purpose: PURPOSE, value: MATERIAL });
        const outcome = svc.resolve('r', 'net.send', {
            tool: 'net.send',
            service: 's3',
            action: 'PutObject',
            target: 'arn:aws:s3:::bucket/a',
        });
        expect(outcome).toMatchObject({ kind: 'rejected', code: 'SIGN_POLICY_VIOLATION' });
    });

    it('constructs and signs the wire format in the gateway', () => {
        const svc = service();
        svc.sever({ refId: 'r', allowedSinks: ['net.send'], purpose: PURPOSE, value: MATERIAL });
        const outcome = svc.resolve('r', 'net.send', {
            tool: 'net.send',
            service: 's3',
            action: 'GetObject',
            target: 'arn:aws:s3:::bucket/a',
        });
        expect(outcome.kind).toBe('signed');
        if (outcome.kind === 'signed') {
            expect(outcome.signed.wire).toContain('GetObject');
            expect(outcome.signed.resource).toBe('arn:aws:s3:::bucket/a');
            expect(outcome.signed.signature.startsWith('sig:')).toBe(true);
        }
    });

    it('keeps a voucher opaque to generic egress', () => {
        const result = guardGenericEgress(
            { body: `${HANDLE_PREFIX}r` },
            { audit: { log: () => {} } },
        );
        expect(result.kind).toBe('rejected');
        expect(result.code).toBe('HANDLE_REFUSED');
    });
});
