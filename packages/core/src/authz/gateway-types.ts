/**
 * ToolGateway contract v2 — the enforce-stage types for the single invocation
 * chokepoint (ToolGateway doc §5, V2 §3/§5.5/§9.3).
 *
 * The gateway consumes an immutable EffectivePolicy snapshot produced by
 * derive(); it never computes policy or widens it. Stages execute in
 * GATEWAY_PIPELINE_STAGES order and every stage emits an audit event.
 */

import type { AuditIdentifiers } from '../observability.js';
import type { ApprovalEcho } from './approval.js';
import type { AuthorizationEngine } from './engine.js';
import type { EgressAttestation } from './ledger.js';
import type {
    CapabilityToken,
    Invocation,
    SecretRef,
    SecretRefResolver,
    SignedRequest,
} from './secret-ref.js';
import type {
    AuthzErrorCode,
    Budget,
    CapabilityKey,
    CapabilityRule,
    EffectivePolicy,
    Role,
    SeveranceMode,
} from './types.js';

/** Tool parameter JSON Schema (bridges to @mazi/provider; core stays schema-agnostic). */
export type JSONSchemaSpec = Record<string, unknown>;

/** confined = sandboxable; full = outside sandbox control (clamped to gated, D3). */
export type ToolTrust = 'confined' | 'full';

export type PendingHandle = string;

/** Value-layer projection declaration (registration states which args carry what). */
export interface ScopeProjection {
    pathParams?: string[];
    hostParams?: string[];
    amountParam?: string;
    commandParam?: string;
    sqlParam?: string;
}

/** Runtime value projection extracted from args (input to scope/verb/egress checks). */
export interface ValueProjection {
    path?: string;
    host?: string;
    amount?: { currency: string; amount: number };
    command?: string;
    sql?: string;
}

export type ScopeProjector = (
    args: Record<string, unknown>,
    projection: ScopeProjection,
) => ValueProjection;

/** Handler context — deliberately minimal (V6: handlers are unprivileged logic). */
export interface HandlerContext {
    signal: AbortSignal;
    /**
     * Resolved credentials for L1/L2 secret refs, keyed by refId. For L1 the
     * handler receives the TCB-constructed SignedRequest, never the wire format
     * (N16) nor the secret material.
     */
    credentials?: ReadonlyMap<string, SignedRequest | CapabilityToken>;
}

export interface ToolOutput {
    value: unknown;
    untrusted?: boolean;
}

export type ToolHandler = (
    args: Record<string, unknown>,
    ctx: HandlerContext,
) => Promise<ToolOutput>;

/** Registry entry. Unregistered tools are forbidden (V5 closed-world). */
export interface ToolRegistration {
    name: string;
    description: string;
    parameters: JSONSchemaSpec;
    /** Dispatch anchor into the effective policy. */
    capability: CapabilityKey;
    /** Additional capabilities jointly dispatched (strictest governs). */
    coCapabilities?: readonly CapabilityKey[];
    scope: ScopeProjection;
    role: Role;
    /** Source severance for ingest tools (R3-hard). */
    severance?: SeveranceMode;
    trust: ToolTrust;
    /** net.fetch / MCP-class: returned value is tagged untrusted. */
    untrustedOutput?: boolean;
    /** Requires the outbound dataflow check (⑨/⑤). */
    dataEgress?: boolean;
    irreversible?: boolean;
    /** Secret ref ids this tool may resolve; only in allowedSinks. */
    secrets?: readonly string[];
    /** Structured invocation builder for L1 signing (handler never builds wire format). */
    invocation?: (args: Record<string, unknown>) => Invocation;
    handler: ToolHandler;
}

/** Supply view exposed to the model (visibility narrowing, not a security boundary). */
export interface ToolSpec {
    name: string;
    description: string;
    parameters: JSONSchemaSpec;
    capability: CapabilityKey;
    effectiveTier: 'auto' | 'gated';
    trust: ToolTrust;
    irreversible?: boolean;
}

/** V12 escalation payload: only strictly-wider requests are considered. */
export interface EscalationPayload {
    requested: CapabilityRule;
    justification: string;
}

export interface InvocationRequest {
    tool: string;
    args: Record<string, unknown>;
    escalation?: EscalationPayload;
    /** Harness-injected attribution overrides (never model-supplied). */
    stepId?: string;
    taskId?: string;
}

export type ApprovalDecision =
    | { decision: 'granted'; scope: 'once' | 'session' | 'workspace' }
    | { decision: 'generation-attestation'; attestation: EgressAttestation }
    | { decision: 'rejected'; reason: string }
    | { decision: 'cancelled' };

export interface ApprovalRequest {
    invocationId: string;
    tool: string;
    capability: CapabilityKey;
    echo: ApprovalEcho;
    /** Harness-injected attribution so the UI can route the request. */
    identifiers: AuditIdentifiers;
}

/** Human-in-the-loop seam; absent → gated calls fail closed (V13). */
export interface ApprovalSeam {
    decide(request: ApprovalRequest): Promise<ApprovalDecision>;
}

export interface SessionApproval {
    id: string;
    capability: CapabilityKey;
    scope: 'session' | 'workspace' | 'generation';
    createdAt: number;
}

export type InvocationResult =
    | { kind: 'executed'; value: unknown; untrusted?: boolean }
    | { kind: 'pending'; handle: PendingHandle; capability: CapabilityKey; hint: string }
    | { kind: 'failed'; error: string; code: AuthzErrorCode }
    | { kind: 'rejected'; code: AuthzErrorCode; hint: string; ruleId?: string };

export interface HookContext {
    tool: ToolSpec;
    args: Record<string, unknown>;
    projection: ValueProjection;
    identifiers: AuditIdentifiers;
    approvals: readonly SessionApproval[];
}

export type HookVerdict =
    | { verdict: 'allow' }
    | { verdict: 'deny'; code: AuthzErrorCode; hint: string };

export interface GatewayHook {
    id: string;
    preExecute(ctx: HookContext): HookVerdict | Promise<HookVerdict>;
    postExecute?(ctx: HookContext & { result: ToolOutput }): void | Promise<void>;
}

/**
 * Canonical pipeline stages (ToolGateway doc §5; acceptance baseline). Dataflow
 * operations map onto them: ⑤ scope-check resolves labels + adjudicates
 * R3-flow conditions + runs the outbound check; ⑨ execute resolves secret refs;
 * ⑩ output-taint writes the ledger and applies the derived-label overlay.
 */
export const GATEWAY_PIPELINE_STAGES = [
    'escalation-short-circuit',
    'supply-check',
    'hook-chain',
    'tier-dispatch',
    'scope-check',
    'danger-match',
    'approval',
    'budget',
    'execute',
    'output-taint',
    'audit',
] as const;

export type GatewayStage = (typeof GATEWAY_PIPELINE_STAGES)[number];

export interface GatewayAuditEvent {
    stage: GatewayStage;
    decision: 'allowed' | 'denied' | 'pending' | 'info';
    identifiers: AuditIdentifiers;
    tool?: string;
    capability?: CapabilityKey;
    detail?: string;
    ruleId?: string;
    code?: AuthzErrorCode;
}

export interface GatewayAuditSink {
    log(event: GatewayAuditEvent): void;
}

/** Value-layer danger rule (command / path / capability matching). */
export interface DangerRule {
    id: string;
    commandPatterns?: readonly RegExp[];
    pathPatterns?: readonly RegExp[];
    capabilities?: readonly CapabilityKey[];
    outcome: 'forbidden' | 'gated';
    reason: string;
}

export interface AppliedDangerRule {
    ruleId: string;
    outcome: DangerRule['outcome'];
    reason: string;
    appliesTo: CapabilityKey[];
}

export interface GatewayBindInput {
    /** Harness-injected identity; stepId is filled per invocation. */
    identifiers: Omit<AuditIdentifiers, 'stepId'> & { stepId?: string };
    effective: EffectivePolicy;
    /** Dataflow engine: ledger, overlay, label resolution, condition verdict. */
    engine: AuthorizationEngine;
    toolRegistry: ReadonlyMap<string, ToolRegistration>;
    budget?: Budget;
    approval?: ApprovalSeam;
    audit: GatewayAuditSink;
    hooks?: readonly GatewayHook[];
    dangerRules?: readonly AppliedDangerRule[];
    project?: ScopeProjector;
    /** Secret refs the tool may resolve, keyed by refId. */
    secretRefs?: ReadonlyMap<string, SecretRef>;
    /** Resolver; declared secrets without one fail closed (V13). */
    secretResolver?: SecretRefResolver;
    now?: () => number;
}

export interface ToolGateway {
    readonly stageNames: readonly GatewayStage[];
    invoke(req: InvocationRequest): Promise<InvocationResult>;
}
