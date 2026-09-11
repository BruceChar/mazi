import { describe, expect, it } from 'vitest';

import {
    egressCheck,
    hashContent,
    normalizeReferencePath,
    pinReference,
    ReferenceDriftError,
    projectArgStrings,
    resolvePinned,
} from '../src/authz/dataflow.js';
import { AssetLabelRegistry } from '../src/authz/labels.js';

const HOME = '/home/tester';

describe('AuthorizationV2 outbound check', () => {
    it('passes a clean projection', () => {
        expect(egressCheck({ url: 'https://example.com', body: 'hello' })).toMatchObject({
            verdict: 'clean',
        });
    });

    it('flags a sensitive fingerprint and returns EGRESS_SENSITIVE', () => {
        const result = egressCheck({
            args: { body: 'report contains TOPSECRET-VALUE' },
            fingerprints: ['TOPSECRET-VALUE'],
        });
        expect(result.verdict).toBe('sensitive');
        expect(result.code).toBe('EGRESS_SENSITIVE');
    });

    it('rejects handles in generic egress (N4)', () => {
        const result = egressCheck({ args: { body: 'secretref:ref:s3' } });
        expect(result).toMatchObject({ verdict: 'handle-rejected', code: 'HANDLE_UNRESOLVABLE' });
    });

    it('passes handles through when configured', () => {
        const result = egressCheck({ args: { body: 'secretref:ref:s3' }, genericEgress: 'passthrough' });
        expect(result.verdict).toBe('handle-passthrough');
    });

    it('projects nested string values', () => {
        expect(projectArgStrings({ a: ['x', { b: 'y' }], c: 3 })).toEqual(['x', 'y']);
    });
});

describe('AuthorizationV2 reference-type sink pinning (N13)', () => {
    it('inline projection is immune to drift', () => {
        const pin = pinReference('/tmp/a.txt', 'v1', 'inline');
        expect(resolvePinned(pin, () => 'v2')).toBe('v1');
    });

    it('hash pinning fails closed on drift (REFERENCE_DRIFT)', () => {
        const pin = pinReference('/tmp/a.txt', 'v1', 'hash');
        expect(resolvePinned(pin, () => 'v1')).toBe('v1');
        expect(() => resolvePinned(pin, () => 'v2')).toThrow(ReferenceDriftError);
        try {
            resolvePinned(pin, () => 'v2');
        } catch (error) {
            expect((error as ReferenceDriftError).code).toBe('REFERENCE_DRIFT');
        }
    });

    it('hashes content deterministically', () => {
        expect(hashContent('v1')).toBe(hashContent('v1'));
        expect(hashContent('v1')).not.toBe(hashContent('v2'));
    });

    it('normalizes realpath before the annotation lookup (symlink redirect caught)', () => {
        const registry = AssetLabelRegistry.builtin({ home: HOME, workspaceRoot: `${HOME}/work` });
        const links = new Map([
            ['/home/tester/link', '/home/tester/.ssh/id_rsa'],
        ]);
        const realpath = (path: string) => links.get(path) ?? path;
        const normalized = normalizeReferencePath('/home/tester/link', realpath, HOME);
        expect(normalized).toBe(`${HOME}/.ssh/id_rsa`);
        expect(registry.resolve({ kind: 'path', value: normalized }).label).toBe('secret');
    });
});
