/**
 * Execution gateway contract (V3 §8).
 *
 * The gateway consumes an immutable EffectivePolicy snapshot produced by
 * derive(); it never computes policy or widens it. Stages execute in
 * GATEWAY_PIPELINE_STAGES order and every stage emits an audit event.
 */

import type { AuditIdentifiers } from '../observability.js';
import type { ApprovalEcho } from './approval.js';
import type { AssetLabelRegistry } from './labels.js';
import type { DataflowLedger, TaintTable } from './ledger.js';
import type {
    Invocation,
    SecretPurpose,
    SecretRef,
    SecretService,
    SignedRequest,
} from './secret.js';
import type {
    AuthzErrorCode,
    Budget,
    CapabilitySpec,
    EffectivePolicy,
    Question,
    ToolSemantics,
    ValueProjection,
} from './types.js';

/** Tool parameter JSON Schema (bridges to @mazi/provider; core stays schema-agnostic). */
export type JSONSchemaSpec = Record<string, unknown>;

/** confined = sandboxable; full = outside sandbox control (clamped to gated). */
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

export interface HandlerContext {
    signal: AbortSignal;
    /** Counter-signed requests keyed by refId; the handler never sees plaintext. */
    credentials?: ReadonlyMap<string, SignedRequest>;
}

export interface ToolOutput {
    value: unknown;
    untrusted?: boolean;
}

export type ToolHandler = (
    args: Record<string, unknown>,
    ctx: HandlerContext,
) => Promise<ToolOutput>;

/** Registry entry. Unregistered tools are forbidden (closed world). */
export interface ToolRegistration {
    name: string;
    description: string;
    parameters: JSONSchemaSpec;
    /** Dispatch anchor into the effective policy. */
    capability: string;
    coCapabilities?: readonly string[];
    /** Three-question declaration for this tool. */
    semantics: ToolSemantics;
    scope: ScopeProjection;
    trust: ToolTrust;
    /** net.fetch / MCP-class: the returned value is tagged untrusted. */
    untrustedOutput?: boolean;
    /** Secret ref ids this tool may resolve; only in allowedSinks. */
    secrets?: readonly string[];
    /** Purpose bound to a severed secret read (mechanism 2 attribute proxy). */
    secretPurpose?: SecretPurpose;
    /** Structured invocation builder for gateway signing. */
    invocation?: (args: Record<string, unknown>) => Invocation;
    handler: ToolHandler;
}

/** Supply view exposed to the model (visibility narrowing, not a security boundary). */
export interface ToolSpec {
    name: string;
    description: string;
    parameters: JSONSchemaSpec;
    capability: string;
    effectiveTier: 'auto' | 'gated';
    trust: ToolTrust;
    irreversible?: boolean;
}

export interface InvocationRequest {
    tool: string;
    args: Record<string, unknown>;
    /** Harness-injected attribution overrides (never model-supplied). */
    stepId?: string;
    taskId?: string;
}

export type ApprovalDecision =
    | { decision: 'granted'; scope: 'once' | 'session' | 'workspace' }
    | { decision: 'rejected'; reason: string }
    | { decision: 'cancelled' };

export interface ApprovalRequest {
    invocationId: string;
    tool: string;
    capability: string;
    echo: ApprovalEcho;
    /** Harness-injected attribution so the UI can route the request. */
    identifiers: AuditIdentifiers;
}

/** Human-in-the-loop seam; absent → gated calls fail closed. */
export interface ApprovalSeam {
    decide(request: ApprovalRequest): Promise<ApprovalDecision>;
}

export interface SessionApproval {
    id: string;
    capability: string;
    scope: 'session' | 'workspace';
    createdAt: number;
}

/**
 * Process-level approval store. The gateway is re-created per execution, so
 * session/workspace grants must live outside it or they are lost between runs.
 * Keyed by capability: approving a gated capability for the session/workspace
 * pre-authorizes further invocations of that capability until revoked.
 */
export interface ApprovalStore {
    remember(approval: SessionApproval): void;
    has(capability: string): boolean;
    list(): readonly SessionApproval[];
    revoke(capability: string): boolean;
}

export class InMemoryApprovalStore implements ApprovalStore {
    private readonly approvals = new Map<string, SessionApproval>();

    remember(approval: SessionApproval): void {
        this.approvals.set(approval.capability, approval);
    }

    has(capability: string): boolean {
        return this.approvals.has(capability);
    }

    list(): readonly SessionApproval[] {
        return [...this.approvals.values()];
    }

    revoke(capability: string): boolean {
        return this.approvals.delete(capability);
    }
}

export type InvocationResult =
    | { kind: 'executed'; value: unknown; untrusted?: boolean }
    | { kind: 'pending'; handle: PendingHandle; capability: string; hint: string }
    | { kind: 'failed'; error: string; code: AuthzErrorCode }
    | { kind: 'rejected'; code: AuthzErrorCode; hint: string; question?: Question };

/**
 * Canonical pipeline stages. Dataflow operations map onto them: risk-check
 * answers Q1/Q2/Q3, ledger-adjudication runs the outbound check, execute
 * resolves vouchers, writeback commits the read and applies residue taint.
 */
export const GATEWAY_PIPELINE_STAGES = [
    'supply-check',
    'scope-check',
    'risk-check',
    'ledger-adjudication',
    'approval',
    'execute',
    'writeback',
    'audit',
] as const;

export type GatewayStage = (typeof GATEWAY_PIPELINE_STAGES)[number];

export interface GatewayAuditEvent {
    stage: GatewayStage;
    decision: 'allowed' | 'denied' | 'pending' | 'info';
    identifiers: AuditIdentifiers;
    tool?: string;
    capability?: string;
    detail?: string;
    code?: AuthzErrorCode;
    question?: Question;
}

export interface GatewayAuditSink {
    log(event: GatewayAuditEvent): void;
}

export interface GatewayBindInput {
    /** Harness-injected identity; stepId is filled per invocation. */
    identifiers: Omit<AuditIdentifiers, 'stepId'> & { stepId?: string };
    policy: EffectivePolicy;
    labels: AssetLabelRegistry;
    ledger: DataflowLedger;
    taint: TaintTable;
    secretService?: SecretService;
    toolRegistry: ReadonlyMap<string, ToolRegistration>;
    budget?: Budget;
    approval?: ApprovalSeam;
    /** Process-level session/workspace grants; omit for per-gateway lifetime. */
    approvalStore?: ApprovalStore;
    audit: GatewayAuditSink;
    now?: () => number;
}

export interface ToolGateway {
    readonly stageNames: readonly GatewayStage[];
    invoke(req: InvocationRequest): Promise<InvocationResult>;
}

/** Re-exported for registration convenience. */
export type { CapabilitySpec, SecretRef };
