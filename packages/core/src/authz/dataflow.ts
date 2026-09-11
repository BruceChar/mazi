/**
 * Dataflow value layer (§6.2/§6.6, N13).
 *
 * Two mechanisms: the outbound check (content projection + handle detection,
 * adjudicated against the same ledger version) and reference-type sink
 * pinning (inline projection or hash pinning + realpath normalization) to
 * close the adjudicate-to-execute TOCTOU window.
 */

import { normalizeAssetPath } from './glob.js';
import { contentVersion } from './hash.js';
import type { LedgerSnapshot } from './ledger.js';
import { isHandleRef } from './secret-ref.js';
import type { AuthzErrorCode } from './types.js';

// ============================================================
// Outbound check
// ============================================================

export type EgressVerdict = 'clean' | 'sensitive' | 'handle-rejected' | 'handle-passthrough';

export interface EgressCheckInput {
    args: unknown;
    /** Same ledger version as the condition adjudication (N8). */
    snapshot?: LedgerSnapshot;
    /** Literal fingerprints known to be sensitive (content probe, best-effort). */
    fingerprints?: readonly string[];
    /** Generic egress handles are never resolved (N4). */
    genericEgress?: 'reject' | 'passthrough';
}

export interface EgressCheckResult {
    verdict: EgressVerdict;
    /** Handle strings and/or fingerprint matches found. */
    hits: string[];
    code?: AuthzErrorCode;
    hint?: string;
}

function projectStrings(value: unknown, out: string[]): void {
    if (typeof value === 'string') {
        out.push(value);
    } else if (Array.isArray(value)) {
        for (const item of value) projectStrings(item, out);
    } else if (value && typeof value === 'object') {
        for (const item of Object.values(value)) projectStrings(item, out);
    }
}

export function projectArgStrings(args: unknown): string[] {
    const out: string[] = [];
    projectStrings(args, out);
    return out;
}

/**
 * Best-effort outbound detection. The probe is probabilistic and does not
 * carry the security promise — that is carried by R3-hard severance — but a
 * hit routes to approval or a structured reject.
 */
export function egressCheck(input: EgressCheckInput): EgressCheckResult {
    const strings = projectArgStrings(input.args);
    const handles = strings.filter(isHandleRef);
    if (handles.length > 0) {
        if ((input.genericEgress ?? 'reject') === 'reject') {
            return {
                verdict: 'handle-rejected',
                hits: handles,
                code: 'HANDLE_UNRESOLVABLE',
                hint: '出站 args 含句柄且无 sanctioned channel：拒绝（N4）',
            };
        }
        return { verdict: 'handle-passthrough', hits: handles };
    }

    const fingerprints = input.fingerprints ?? [];
    const hits = fingerprints.filter((fingerprint) =>
        strings.some((value) => value.includes(fingerprint)),
    );
    if (hits.length > 0) {
        return {
            verdict: 'sensitive',
            hits,
            code: 'EGRESS_SENSITIVE',
            hint: '出站内容命中敏感指纹：转审批或拒绝',
        };
    }
    return { verdict: 'clean', hits: [] };
}

// ============================================================
// Reference-type sink pinning (N13)
// ============================================================

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

/**
 * Resolve a pinned reference at execution time. Inline pins are immune to
 * drift; hash pins re-read and fail closed on mismatch (`REFERENCE_DRIFT`).
 */
export function resolvePinned(pin: ReferencePin, read: (path: string) => string): string {
    if (pin.kind === 'inline') return pin.content;
    const current = read(pin.path);
    if (hashContent(current) !== pin.hash) throw new ReferenceDriftError(pin.path);
    return current;
}

/**
 * Realpath normalization must happen inside the TCB before the annotation
 * lookup, otherwise a symlink redirects the check (P21/N13).
 */
export function normalizeReferencePath(
    input: string,
    realpath: (path: string) => string,
    home?: string,
): string {
    return normalizeAssetPath(realpath(input), home);
}
