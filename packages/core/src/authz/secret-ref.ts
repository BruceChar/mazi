/**
 * SecretRef resolution — the three-level ladder (§6.3/§6.4, N4/N9/N12/N16).
 *
 * The resolver is the only point where a handle is turned into a credential
 * use. L1 signs a structured invocation: the signer constructs the wire format
 * (handler never touches it, N16) after validating the structured signing
 * policy (N12). L2 issues a short-TTL revocable capability token. L3 injects
 * plaintext and requires a root-signed exception. Args handles are always
 * opaque; generic egress never resolves them (N4).
 */

import { stableStringify } from './hash.js';
import type { AuthzErrorCode, SensitivityLabel } from './types.js';

export type ParseLevel = 'L1' | 'L2' | 'L3';

const LEVEL_RANK: Readonly<Record<ParseLevel, number>> = { L1: 3, L2: 2, L3: 1 };

export interface SigningConditions {
    maxBodyBytes?: number;
    allowedHeaders?: string[];
    maxTTL?: number;
    sourceIpCidr?: string;
    maxUses?: number;
    maxUsesWindow?: number;
}

export interface SigningPolicy {
    service: string;
    actions: string[];
    resourcePattern: string;
    conditions?: SigningConditions;
}

export interface SecretRef {
    refId: string;
    label: SensitivityLabel;
    allowedSinks: string[];
    purpose: SigningPolicy;
    parseLevel: ParseLevel;
    credentialId: string;
    /** Root-signed L3 exception (required for L3 resolution). */
    l3Exception?: boolean;
}

export interface Invocation {
    tool: string;
    service: string;
    action: string;
    target: string;
    body?: string;
    headers?: Record<string, string>;
    sourceIp?: string;
}

export interface SignedRequest {
    refId: string;
    service: string;
    action: string;
    /** TCB-normalized resource. */
    resource: string;
    /** TCB-constructed wire format — handler never supplies or sees this. */
    wire: string;
    signature: string;
    keyId: string;
}

export interface CapabilityToken {
    token: string;
    refId: string;
    allowedSinks: string[];
    issuedAt: number;
    expiresAt: number;
}

export type HandleAuditEvent =
    | { type: 'handle-ref'; refId: string; tool: string }
    | { type: 'handle-inject-origin'; refId: string; tool: string }
    | { type: 'handle-refused'; refId: string; tool: string; reason: string }
    | {
          type: 'sign-policy-passed';
          refId: string;
          service: string;
          action: string;
          resource: string;
          maxUses?: number;
      }
    | { type: 'sign-policy-violation'; refId: string; tool: string; reason: string }
    | { type: 'sign-max-uses-exceeded'; refId: string; maxUses: number }
    | { type: 'token-issued'; refId: string; token: string; expiresAt: number }
    | { type: 'token-revoked'; refId: string; token: string };

export interface HandleAuditSink {
    log(event: HandleAuditEvent): void;
}

export interface ResolverDeps {
    sign(payload: string, credentialId: string): string;
    audit: HandleAuditSink;
    /** Highest parse level the tool supports (registration declaration). */
    toolMaxParseLevel(tool: string): ParseLevel;
    now?: () => number;
    revocation?: TokenRevocationList;
    isL3ExceptionSigned?(ref: SecretRef, tool: string): boolean;
    hasSanctionedChannel?(ref: SecretRef, tool: string): boolean;
}

export type ResolveOutcome =
    | { kind: 'signed'; signed: SignedRequest }
    | { kind: 'token'; token: CapabilityToken }
    | { kind: 'injected'; refId: string; tool: string }
    | { kind: 'rejected'; code: AuthzErrorCode; hint: string };

export class TokenRevocationList {
    private readonly revoked = new Set<string>();

    revoke(token: string): void {
        this.revoked.add(token);
    }

    isRevoked(token: string): boolean {
        return this.revoked.has(token);
    }
}

/**
 * The effective level is the more conservative of the ref configuration and
 * the tool's declared capability, so an L1-capable tool can never be pushed
 * down to L3 by a hostile handler.
 */
export function selectParseLevel(refLevel: ParseLevel, toolLevel: ParseLevel): ParseLevel {
    return LEVEL_RANK[refLevel] <= LEVEL_RANK[toolLevel] ? refLevel : toolLevel;
}

/** TCB normalization: decode, collapse separators, resolve '.' and '..'. */
export function normalizeTarget(target: string): string {
    let decoded = target.trim();
    try {
        decoded = decodeURIComponent(decoded);
    } catch {
        // Malformed encoding stays as-is; it cannot match a well-formed pattern.
    }
    const segments = decoded.split('/');
    const resolved: string[] = [];
    for (const segment of segments) {
        if (segment === '' || segment === '.') continue;
        if (segment === '..') {
            resolved.pop();
            continue;
        }
        resolved.push(segment);
    }
    return resolved.join('/');
}

/** Resource patterns (ARNs / URLs) use `*` as a suffix wildcard spanning '/'. */
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

export function matchResource(target: string, pattern: string): boolean {
    return resourceToRegExp(normalizeTarget(pattern)).test(normalizeTarget(target));
}

interface UsageRecord {
    timestamps: number[];
}

class MaxUsesTracker {
    private readonly uses = new Map<string, UsageRecord>();

    check(ref: SecretRef, now: number): boolean {
        const conditions = ref.purpose.conditions;
        if (!conditions?.maxUses) return true;
        const record = this.uses.get(ref.refId) ?? { timestamps: [] };
        const window = conditions.maxUsesWindow ?? Number.POSITIVE_INFINITY;
        record.timestamps = record.timestamps.filter((t) => now - t <= window);
        this.uses.set(ref.refId, record);
        if (record.timestamps.length >= conditions.maxUses) return false;
        record.timestamps.push(now);
        return true;
    }
}

function bodyBytes(body: string | undefined): number {
    if (body === undefined) return 0;
    return new TextEncoder().encode(body).length;
}

function policyCheck(ref: SecretRef, invocation: Invocation): string | undefined {
    if (invocation.service !== ref.purpose.service) return 'service-mismatch';
    if (!ref.purpose.actions.includes(invocation.action)) return 'action-not-allowed';
    if (!matchResource(invocation.target, ref.purpose.resourcePattern)) return 'resource-mismatch';

    const conditions = ref.purpose.conditions;
    if (!conditions) return undefined;
    if (
        conditions.maxBodyBytes !== undefined &&
        bodyBytes(invocation.body) > conditions.maxBodyBytes
    ) {
        return 'body-too-large';
    }
    if (conditions.allowedHeaders) {
        for (const header of Object.keys(invocation.headers ?? {})) {
            if (!conditions.allowedHeaders.includes(header)) return `header-not-allowed:${header}`;
        }
    }
    if (conditions.sourceIpCidr && invocation.sourceIp && !conditions.sourceIpCidr.endsWith('*')) {
        if (invocation.sourceIp !== conditions.sourceIpCidr) return 'source-ip-mismatch';
    }
    return undefined;
}

/** The single TCB constructor of the wire format (N16/P21). */
export function constructWire(
    ref: SecretRef,
    invocation: Invocation,
    normalizedTarget: string,
): string {
    const headers = Object.entries(invocation.headers ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k.toLowerCase()}:${v}`)
        .join(';');
    return stableStringify({
        service: ref.purpose.service,
        action: invocation.action,
        target: normalizedTarget,
        headers,
        body: invocation.body ?? '',
    });
}

export class SecretRefResolver {
    private readonly maxUses = new MaxUsesTracker();
    private readonly now: () => number;

    constructor(private readonly deps: ResolverDeps) {
        this.now = deps.now ?? (() => Date.now());
    }

    resolve(ref: SecretRef, invocation: Invocation): ResolveOutcome {
        if (!ref.allowedSinks.includes(invocation.tool)) {
            this.deps.audit.log({
                type: 'handle-refused',
                refId: ref.refId,
                tool: invocation.tool,
                reason: 'tool-not-in-allowed-sinks',
            });
            return rejected(
                'HANDLE_REFUSED',
                `句柄 ${ref.refId} 不允许在工具 ${invocation.tool} 中解析`,
            );
        }

        const level = selectParseLevel(
            ref.parseLevel,
            this.deps.toolMaxParseLevel(invocation.tool),
        );
        this.deps.audit.log({ type: 'handle-ref', refId: ref.refId, tool: invocation.tool });

        if (level === 'L1') return this.sign(ref, invocation);
        if (level === 'L2') return this.issueToken(ref, invocation);
        return this.inject(ref, invocation);
    }

    private sign(ref: SecretRef, invocation: Invocation): ResolveOutcome {
        const violation = policyCheck(ref, invocation);
        if (violation) {
            this.deps.audit.log({
                type: 'sign-policy-violation',
                refId: ref.refId,
                tool: invocation.tool,
                reason: violation,
            });
            return rejected('SIGN_POLICY_VIOLATION', `签名策略校验失败：${violation}`);
        }

        if (!this.maxUses.check(ref, this.now())) {
            const max = ref.purpose.conditions?.maxUses ?? 0;
            this.deps.audit.log({ type: 'sign-max-uses-exceeded', refId: ref.refId, maxUses: max });
            return rejected('SIGN_MAX_USES_EXCEEDED', `签名凭证重放超限（maxUses=${max}）`);
        }

        const normalizedTarget = normalizeTarget(invocation.target);
        const wire = constructWire(ref, invocation, normalizedTarget);
        const signature = this.deps.sign(wire, ref.credentialId);
        this.deps.audit.log({
            type: 'sign-policy-passed',
            refId: ref.refId,
            service: ref.purpose.service,
            action: invocation.action,
            resource: normalizedTarget,
            maxUses: ref.purpose.conditions?.maxUses,
        });
        return {
            kind: 'signed',
            signed: {
                refId: ref.refId,
                service: ref.purpose.service,
                action: invocation.action,
                resource: normalizedTarget,
                wire,
                signature,
                keyId: ref.credentialId,
            },
        };
    }

    private issueToken(ref: SecretRef, invocation: Invocation): ResolveOutcome {
        const now = this.now();
        const configured = ref.purpose.conditions?.maxTTL ?? 60_000;
        const ttl = Math.min(configured, 60_000);
        const token: CapabilityToken = {
            token: `tok:${ref.refId}:${now}`,
            refId: ref.refId,
            allowedSinks: [...ref.allowedSinks],
            issuedAt: now,
            expiresAt: now + ttl,
        };
        this.deps.audit.log({
            type: 'token-issued',
            refId: ref.refId,
            token: token.token,
            expiresAt: token.expiresAt,
        });
        void invocation;
        return { kind: 'token', token };
    }

    private inject(ref: SecretRef, invocation: Invocation): ResolveOutcome {
        const sanctioned =
            this.deps.isL3ExceptionSigned?.(ref, invocation.tool) === true ||
            ref.l3Exception === true;
        if (!sanctioned || this.deps.hasSanctionedChannel?.(ref, invocation.tool) === false) {
            this.deps.audit.log({
                type: 'handle-refused',
                refId: ref.refId,
                tool: invocation.tool,
                reason: 'l3-exception-absent',
            });
            return rejected(
                'HANDLE_REFUSED',
                'L3 原文注入需根层签署 L3 例外且存在 sanctioned channel',
            );
        }
        this.deps.audit.log({
            type: 'handle-inject-origin',
            refId: ref.refId,
            tool: invocation.tool,
        });
        return { kind: 'injected', refId: ref.refId, tool: invocation.tool };
    }

    verifyToken(token: CapabilityToken): boolean {
        if (this.deps.revocation?.isRevoked(token.token)) return false;
        return this.now() < token.expiresAt;
    }

    revokeToken(token: CapabilityToken): void {
        this.deps.revocation?.revoke(token.token);
        this.deps.audit.log({ type: 'token-revoked', refId: token.refId, token: token.token });
    }
}

function rejected(code: AuthzErrorCode, hint: string): ResolveOutcome {
    return { kind: 'rejected', code, hint };
}

// ============================================================
// Generic egress: args handles stay opaque (N4)
// ============================================================

export const HANDLE_PREFIX = 'secretref:';

export function isHandleRef(value: unknown): value is string {
    return typeof value === 'string' && value.startsWith(HANDLE_PREFIX);
}

/** Recursively collect handle strings present anywhere in args. */
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

export interface GenericEgressGuardOptions {
    mode?: 'reject' | 'passthrough';
    audit: HandleAuditSink;
}

export interface GenericEgressGuardResult {
    kind: 'clean' | 'passthrough' | 'rejected';
    handles: string[];
    code?: AuthzErrorCode;
    hint?: string;
}

/**
 * Generic egress (`net.send` with an arbitrary body) never resolves a handle:
 * it either rejects (`HANDLE_UNRESOLVABLE`) or passes it through as opaque
 * data. Either way a first-class audit event is recorded.
 */
export function guardGenericEgress(
    args: unknown,
    opts: GenericEgressGuardOptions,
): GenericEgressGuardResult {
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
        code: 'HANDLE_UNRESOLVABLE',
        hint: 'generic egress 收到句柄且无 sanctioned channel：拒绝或配置为原样透传',
    };
}
