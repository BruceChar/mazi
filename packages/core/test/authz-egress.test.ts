import { describe, expect, it } from 'vitest';

import {
    hashContent,
    normalizeReferencePath,
    pinReference,
    projectArgStrings,
    ReferenceDriftError,
    resolvePinned,
} from '../src/authz/egress.js';

describe('authz egress value layer', () => {
    it('projects every string reachable through args', () => {
        expect(projectArgStrings({ a: 'x', b: ['y', { c: 'z' }] })).toEqual(['x', 'y', 'z']);
    });

    it('keeps an inline pin immune to later writes', () => {
        const pin = pinReference('/w/report.txt', 'clean');
        expect(resolvePinned(pin, () => 'tampered')).toBe('clean');
    });

    it('fails closed when a hash pin drifts', () => {
        const pin = pinReference('/w/report.txt', 'clean', 'hash');
        expect(resolvePinned(pin, () => 'clean')).toBe('clean');
        expect(() => resolvePinned(pin, () => 'tampered')).toThrow(ReferenceDriftError);
    });

    it('normalizes a reference path through realpath', () => {
        expect(normalizeReferencePath('~/.x', () => '/real/.x', '/home/t')).toBe('/real/.x');
        expect(hashContent('a')).toHaveLength(8);
    });
});
