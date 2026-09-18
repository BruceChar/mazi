/**
 * Secret severance and the gateway signer (V3 §6.2 / §6.2.1).
 *
 * Secret-level reads do not return the plaintext: the gateway computes a curated
 * attribute set in the same pass (INV-D) and returns a voucher (handle). Later
 * use is validated against the voucher's purpose and counter-signed by the
 * gateway, which is the only constructor of the wire format. The voucher is
 * opaque to generic egress; attributes may only be drawn from the curated set
 * (INV-C).
 */

import { matchGlob } from './glob.js';
import { stableStringify } from './hash.js';
import type { AuthzErrorCode } from './types.js';

// ============================================================
// §6.2.1 Curated attribute proxy
// ============================================================

export type AttributeKind = 'kind' | 'prefix-class' | 'length-bucket' | 'validity';

export const CURATED_ATTRIBUTE_KINDS: readonly AttributeKind[] = [
    'kind',
    'prefix-class',
    'length-bucket',
    'validity',
] as const;

export type SecretKind = 'api-key' | 'private-key' | 'oauth-token' | 'password';
export type PrefixClass = 'sk-' | 'ghp_' | 'AKIA' | 'xoxb-' | 'none';
export type LengthBucket = '≤32' | '33–64' | '>64';
export type Validity = 'format-ok' | 'malformed';

/** Only fields that do not shrink the search space may be disclosed. */
export interface SecretAttributes {
    kind?: SecretKind;
    prefixClass?: PrefixClass;
    lengthBucket?: LengthBucket;
    validity?: Validity;
}

export interface RedactionProfile {
    pattern: string;
    attributes: readonly AttributeKind[];
}

export const DEFAULT_REDACTION_PROFILES: readonly RedactionProfile[] = [
    { pattern: '**/.env*', attributes: ['kind', 'prefix-class', 'validity'] },
    { pattern: '**/id_rsa*', attributes: ['kind', 'validity'] },
    { pattern: '**/*.pem', attributes: ['kind', 'validity'] },
    { pattern: '**/credentials*', attributes: ['kind', 'prefix-class', 'validity'] },
    { pattern: '**/.aws/**', attributes: ['kind', 'prefix-class', 'validity'] },
] as const;

function classifyKind(value: string): SecretKind {
    if (value.includes('-----BEGIN') && value.includes('PRIVATE KEY')) return 'private-key';
    if (/^(sk-|AKIA|ghp_|xoxb-)/.test(value)) return 'api-key';
    if (value.startsWith('xoxb-') || /token/i.test(value)) return 'oauth-token';
    return 'password';
}

function classifyPrefix(value: string): PrefixClass {
    for (const prefix of ['sk-', 'ghp_', 'AKIA', 'xoxb-'] as const) {
        if (value.startsWith(prefix)) return prefix;
    }
    return 'none';
}

function classifyLength(value: string): LengthBucket {
    if (value.length <= 32) return '≤32';
    if (value.length <= 64) return '33–64';
    return '>64';
}

function classifyValidity(value: string): Validity {
    if (value.length === 0 || /\s/.test(value)) return 'malformed';
    return 'format-ok';
}

/** INV-C: only curated attribute kinds are ever computed or disclosed. */
export function assertCurated(kinds: readonly AttributeKind[]): void {
    for (const kind of kinds) {
        if (!CURATED_ATTRIBUTE_KINDS.includes(kind)) {
            throw new Error(`非策展属性被请求：${kind}（INV-C）`);
        }
    }
}

/**
 * INV-D: attributes are computed in the same pass that reads the plaintext; no
 * second read is performed and the raw bytes never leave this function.
 */
export function computeAttributes(
    value: string,
    kinds: readonly AttributeKind[],
): SecretAttributes {
    assertCurated(kinds);
    const attributes: SecretAttributes = {};
    for (const kind of kinds) {
        if (kind === 'kind') attributes.kind = classifyKind(value);
        if (kind === 'prefix-class') attributes.prefixClass = classifyPrefix(value);
        if (kind === 'length-bucket') attributes.lengthBucket = classifyLength(value);
        if (kind === 'validity') attributes.validity = classifyValidity(value);
    }
    return attributes;
}

// ============================================================
// §6.2 Voucher and gateway signer
// ============================================================

export interface SecretPurpose {
    service: string;
    actions: string[];
    resourcePattern: string;
}

export interface SecretRef {
    refId: string;
    /** Bounded at creation time; never model-supplied. */
    allowedSinks: string[];
    purpose: SecretPurpose;
}

export interface SeveredSecret {
    handle: string;
    ref: SecretRef;
    attributes: SecretAttributes;
}

export const HANDLE_PREFIX = 'secretref:';

export function isHandleRef(value: unknown): value is string {
    return typeof value === 'string' && value.startsWith(HANDLE_PREFIX);
}

export function scanForHandles(args: unknown): string[] {
    const found: string[] = [];
    const visit = (value: unknown): void => {
        if (isHandleRef(value)) {
            found.push(value);
        } else if (Array.isArray(value)) {
            value.forEach(visit);
        } else if (value && typeof value === 'object') {
            Object.values(value).forEach(visit);
        }
    };
    visit(args);
    return found;
}

export interface Invocation {
    tool: string;
    service: string;
    action: string;
    target: string;
    body?: string;
    headers?: Record<string, string>;
}

export interface SignedRequest {
    refId: string;
    service: string;
    action: string;
    resource: string;
    /** TCB-constructed wire format; the handler never supplies or sees it. */
    wire: string;
    signature: string;
    keyId: string;
}

export type ResolveOutcome =
    | { kind: 'signed'; signed: SignedRequest }
    | { kind: 'rejected'; code: AuthzErrorCode; hint: string };

export interface SecretAuditSink {
    log(event: { type: string; [key: string]: unknown }): void;
}

function resourceToRegExp(pattern: string): RegExp {
    let source = '';
    for (const ch of pattern) {
        if (ch === '*') source += '.*';
        else if (ch === '?') source += '.';
        else if (/[\\^$.*+?()[\]{}|]/.test(ch)) source += `\\${ch}`;
        else source += ch;
    }
    return new RegExp(`^${source}$`);
}

/** TCB normalization: decode, collapse separators and resolve '.'/'..'. */
export function normalizeTarget(target: string): string {
    let decoded = target.trim();
    try {
        decoded = decodeURIComponent(decoded);
    } catch {
        // Malformed encoding stays as-is; it cannot match a well-formed pattern.
    }
    const resolved: string[] = [];
    for (const segment of decoded.split('/')) {
        if (segment === '' || segment === '.') continue;
        if (segment === '..') {
            resolved.pop();
            continue;
        }
        resolved.push(segment);
    }
    return resolved.join('/');
}

export function matchResource(target: string, pattern: string): boolean {
    return resourceToRegExp(normalizeTarget(pattern)).test(normalizeTarget(target));
}

/** The single TCB constructor of the wire format. */
export function constructWire(ref: SecretRef, invocation: Invocation, resource: string): string {
    const headers = Object.entries(invocation.headers ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k.toLowerCase()}:${v}`)
        .join(';');
    return stableStringify({
        service: ref.purpose.service,
        action: invocation.action,
        target: resource,
        headers,
        body: invocation.body ?? '',
    });
}

export interface SeverInput {
    refId: string;
    allowedSinks: string[];
    purpose: SecretPurpose;
    /** Plaintext, consumed once (INV-D). */
    value: string;
    profile?: RedactionProfile;
}

export interface SecretServiceOptions {
    /** TCB signing primitive; the material never leaves this callback's frame. */
    sign: (payload: string, material: string) => string;
    profiles?: readonly RedactionProfile[];
    audit?: SecretAuditSink;
}

interface VaultEntry {
    ref: SecretRef;
    material: string;
}

export class SecretService {
    private readonly vault = new Map<string, VaultEntry>();
    private readonly profiles: readonly RedactionProfile[];
    private readonly audit?: SecretAuditSink;

    constructor(private readonly opts: SecretServiceOptions) {
        this.profiles = opts.profiles ?? DEFAULT_REDACTION_PROFILES;
        this.audit = opts.audit;
    }

    /**
     * Sever a secret read. The plaintext is retained in the TCB vault only; the
     * returned value carries a voucher and curated attributes.
     */
    sever(input: SeverInput): SeveredSecret {
        const attributes = computeAttributes(input.value, input.profile?.attributes ?? []);
        const ref: SecretRef = {
            refId: input.refId,
            allowedSinks: [...input.allowedSinks],
            purpose: input.purpose,
        };
        this.vault.set(input.refId, { ref, material: input.value });
        this.audit?.log({ type: 'secret-severed', refId: input.refId });
        return { handle: `${HANDLE_PREFIX}${input.refId}`, ref, attributes };
    }

    has(refId: string): boolean {
        return this.vault.has(refId);
    }

    /** Redaction profile selected by target path; defaults to kind + validity. */
    profileFor(target: string): RedactionProfile {
        for (const profile of this.profiles) {
            if (matchGlob(profile.pattern, target)) return profile;
        }
        return { pattern: target, attributes: ['kind', 'validity'] };
    }

    /** Validate the tool/purpose and counter-sign a structured invocation. */
    resolve(refId: string, tool: string, invocation: Invocation): ResolveOutcome {
        const entry = this.vault.get(refId);
        if (!entry) {
            return {
                kind: 'rejected',
                code: 'HANDLE_REFUSED',
                hint: `未知或已失效的句柄：${refId}`,
            };
        }
        if (!entry.ref.allowedSinks.includes(tool)) {
            this.audit?.log({
                type: 'handle-refused',
                refId,
                tool,
                reason: 'tool-not-in-allowed-sinks',
            });
            return {
                kind: 'rejected',
                code: 'HANDLE_REFUSED',
                hint: `句柄 ${refId} 不允许在工具 ${tool} 中解析`,
            };
        }
        const violation = this.policyViolation(entry.ref, invocation);
        if (violation) {
            this.audit?.log({ type: 'sign-policy-violation', refId, tool, reason: violation });
            return {
                kind: 'rejected',
                code: 'SIGN_POLICY_VIOLATION',
                hint: `签名策略校验失败：${violation}`,
            };
        }
        const resource = normalizeTarget(invocation.target);
        const wire = constructWire(entry.ref, invocation, resource);
        const signed: SignedRequest = {
            refId,
            service: entry.ref.purpose.service,
            action: invocation.action,
            resource,
            wire,
            signature: this.opts.sign(wire, entry.material),
            keyId: refId,
        };
        this.audit?.log({
            type: 'sign-policy-passed',
            refId,
            service: signed.service,
            action: signed.action,
            resource,
        });
        return { kind: 'signed', signed };
    }

    private policyViolation(ref: SecretRef, invocation: Invocation): string | undefined {
        if (invocation.service !== ref.purpose.service) return 'service-mismatch';
        if (!ref.purpose.actions.includes(invocation.action)) return 'action-not-allowed';
        if (!matchResource(invocation.target, ref.purpose.resourcePattern))
            return 'resource-mismatch';
        return undefined;
    }
}

// ============================================================
// Voucher opacity (N4): generic egress never resolves a handle
// ============================================================

export interface OpaqueEgressResult {
    kind: 'clean' | 'passthrough' | 'rejected';
    handles: string[];
    code?: AuthzErrorCode;
    hint?: string;
}

export function guardGenericEgress(
    args: unknown,
    opts: { mode?: 'reject' | 'passthrough'; audit: SecretAuditSink },
): OpaqueEgressResult {
    const handles = scanForHandles(args);
    if (handles.length === 0) return { kind: 'clean', handles };
    const mode = opts.mode ?? 'reject';
    for (const handle of handles) {
        opts.audit.log({
            type: 'handle-refused',
            refId: handle,
            tool: 'generic-egress',
            reason: mode === 'reject' ? 'no-sanctioned-channel' : 'passthrough-as-data',
        });
    }
    if (mode === 'passthrough') return { kind: 'passthrough', handles };
    return {
        kind: 'rejected',
        handles,
        code: 'HANDLE_REFUSED',
        hint: 'generic egress 收到句柄且无 sanctioned channel：拒绝或配置为原样透传',
    };
}
