/**
 * Egress value layer (V3 §6.3 implementation disciplines).
 *
 * Reference-type sinks must be pinned at adjudication time: inline projection is
 * immune to drift; hash pinning re-reads at execution and fails closed on
 * mismatch. This closes the "clean at adjudication, written before execution"
 * timing window.
 */

import { normalizeAssetPath } from './glob.js';
import { contentVersion } from './hash.js';

/** Recursively collect every string reachable through args. */
export function projectArgStrings(args: unknown): string[] {
    const out: string[] = [];
    const visit = (value: unknown): void => {
        if (typeof value === 'string') {
            out.push(value);
        } else if (Array.isArray(value)) {
            value.forEach(visit);
        } else if (value && typeof value === 'object') {
            Object.values(value).forEach(visit);
        }
    };
    visit(args);
    return out;
}

export type ReferencePin =
    | { kind: 'inline'; content: string }
    | { kind: 'hash'; path: string; hash: string };

export class ReferenceDriftError extends Error {
    readonly code = 'REFERENCE_DRIFT' as const;
    constructor(path: string) {
        super(`引用型 sink 内容在裁决后发生变化：${path}`);
        this.name = 'ReferenceDriftError';
    }
}

export function hashContent(content: string): string {
    return contentVersion(content).toString(16);
}

/** Default is inline projection; hash pinning is for large payloads. */
export function pinReference(
    path: string,
    content: string,
    mode: 'inline' | 'hash' = 'inline',
): ReferencePin {
    if (mode === 'inline') return { kind: 'inline', content };
    return { kind: 'hash', path, hash: hashContent(content) };
}

/** Inline pins are immune; hash pins re-read and fail closed on mismatch. */
export function resolvePinned(pin: ReferencePin, read: (path: string) => string): string {
    if (pin.kind === 'inline') return pin.content;
    const current = read(pin.path);
    if (hashContent(current) !== pin.hash) throw new ReferenceDriftError(pin.path);
    return current;
}

/** Realpath normalization must happen inside the TCB before annotation lookup. */
export function normalizeReferencePath(
    input: string,
    realpath: (path: string) => string,
    home?: string,
): string {
    return normalizeAssetPath(realpath(input), home);
}
