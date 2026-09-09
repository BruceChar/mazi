/**
 * ToolGateway contract — the single enforcement point for tool invocation.
 *
 * Permission lifecycle: grant (root signing) → derive (policy computation) →
 * enforce (call-time). This file defines the enforce-stage contract: whether a
 * given invocation is allowed and how it is executed.
 *
 * Invocations flow through the pipeline stages declared in
 * GATEWAY_PIPELINE_STAGES, in order; enforcement is fail-closed — an absent
 * approval seam or unresolvable secrets reject the call rather than hang
 * (V13). The tools whitelist (ToolSpec) narrows the model's view but is NOT a
 * security boundary: hallucinated calls to unlisted tools are still rejected.
 *
 * Sandbox deployment conventions (binding between the effect surface and the
 * execution environment; provisioned by the Deployer):
 *   D1 fs.exec — sandbox profile derives from the effective fs/net surface
 *       (read rules → read scope, write → write scope, net → no/proxied
 *       namespace); a runtime EPERM translates to a policy rejection.
 *   D2 net.*   — proxy-only egress; DNS rebinding guarded by resolve → pin →
 *       connect → re-verify.
 *   D3 full    — trust: 'full' processes run outside the sandbox; tier
 *       clamped to gated; secrets injected into the process env, never args.
 *
 * Invariant index: V5 closed-world · V6 single chokepoint / unprivileged
 * handlers · V8 always-gated never exempt · V11 harness-injected identity ·
 * V12 escalation short-circuit · V13 fail-closed · V14 monotonic hook deny.
 */

import type { ApprovalSeam } from './approval.js';
import type {
    AppliedDangerRule,
    Budget,
    EffectClass,
    EffectivePolicy,
    EffectRule,
    PermissionLevel,
    RejectCode,
    SideEffectScope,
} from './authorization.js';
import type { TraceIdentifiers } from './observability.js';

/** Sandbox execution configuration (temporary definition pending convergence with the executor contract). */
export interface SandboxSpec {
    enabled: boolean;
    network?: { allowInternet: boolean; allowedHosts?: string[] };
    filesystem?: { writableRoots?: string[] };
    process?: { allowSpawn: boolean };
}

/** Tool parameter JSON Schema (open structure; provider-core expresses it via ToolSchema.parameters). */
export type JSONSchemaSpec = Record<string, unknown>;

// ============================================================
// §1 Tool registration contract (V5 registration point)
// ============================================================

/**
 * Trust annotation for external processes.
 * confined — sandboxable (handler runs in D1/D2 environments);
 * full     — outside sandbox control (MCP servers, plugins; D3); effective
 *            tier is clamped to gated and every call records a first-class
 *            risk event.
 */
export type ToolTrust = 'confined' | 'full';

/**
 * Secret reference resolved by the Deployer when provisioning the sandbox
 * (env var / mounted file injected into the process environment). Secrets
 * never appear in args (model-visible) nor in ToolSpec (supply side). The
 * resolution table belongs to Deployer configuration, not to this contract.
 * Declared-but-unresolvable secrets → fail-closed rejection (V13, mapped to
 * SANDBOX_UNAVAILABLE — secret injection is part of environment provisioning).
 */
export type SecretRef = string;

/**
 * Value-layer projection declaration: registration states which args carry
 * paths / hosts / amounts / commands / SQL; the implementation extracts the
 * values at runtime for the scope-check and danger-match stages.
 */
export interface ScopeProjection {
    /** Arg names whose values are file paths */
    pathParams?: string[];
    /** Arg names whose values are domains / URLs */
    hostParams?: string[];
    /** Arg name for the amount (pay-class: { currency, amount } or number) */
    amountParam?: string;
    /** Arg name carrying command content (fs.exec-class, matched against commandPatterns) */
    commandParam?: string;
    /** Arg name carrying the SQL statement (db.*-class, matched against sqlPredicates) */
    sqlParam?: string;
}

/** Runtime value projection extracted from args (input to scope-check and danger-match). */
export interface ValueProjection {
    path?: string;
    host?: string;
    amount?: { currency: string; amount: number };
    command?: string;
    sql?: string;
}

/** Projection function signature (implemented in the executor layer). */
export type ScopeProjector = (
    args: Record<string, unknown>,
    projection: ScopeProjection,
) => ValueProjection;

/**
 * Tool execution context — deliberately minimal.
 *
 * V6: handlers are unprivileged pure logic. No policy access, no registry,
 * no identity, no permission API — permission checks have exactly one
 * execution point (the gateway pipeline) and environment provisioning has
 * exactly one execution point (the Deployer in the executor layer). A handler
 * cannot and must not perform permission decisions.
 */
export interface HandlerContext {
    /** Cancellation signal (timeout / kill switch / budget abort) */
    signal: AbortSignal;
}

/** Tool return value. untrusted = true routes the value through output processing (output-taint). */
export interface ToolOutput {
    value: unknown;
    untrusted?: boolean;
}

/** Tool implementation body. */
export type ToolHandler = (
    args: Record<string, unknown>,
    ctx: HandlerContext,
) => Promise<ToolOutput>;

/**
 * Registry entry. Unregistered tools are forbidden (V5 closed-world).
 *
 * Slicing rule: slice by effect surface, not by capability. A generic
 * http(method, url, body) whose method decides fetch/send semantics is an
 * anti-pattern — split it into two registrations so dispatch is statically
 * decidable.
 */
export interface ToolRegistration {
    name: string;
    description: string;
    /** TypeBox-compatible shape (bridges to @mazi/provider); core does not import pi-ai */
    parameters: JSONSchemaSpec;

    /** Dispatch anchor: tier dispatch, primary audit class, escalation target */
    effectClass: EffectClass;

    /**
     * Additional effect classes involved in a single call.
     * Dispatch semantics: effectClass AND all coEffects must be non-forbidden;
     * the strictest tier governs; each class's scopes (paths/hosts/amountLimit)
     * are checked independently — any miss routes to approval.
     * Applies to multi-effect in-process tools (payment API = pay + net.send).
     * NOT for bash-class dynamic tools — their fs/net surfaces are enforced by
     * the sandbox at runtime (D1), not via coEffects.
     */
    coEffects?: readonly EffectClass[];

    /** Value-layer projection declaration for scope-check */
    scope: ScopeProjection;

    /** net.fetch / MCP-class tools set this: return values are tagged untrusted (output-taint) */
    untrustedOutput?: boolean;

    trust: ToolTrust;

    /** Irreversibility flag (delete/db.schema/pay/publish semantics; triggers stricter approval echo) */
    irreversible?: boolean;

    /** Idempotency declaration for retry decisions */
    idempotent?: boolean;

    /** Tool-level timeout (ms), merged into HandlerContext.signal */
    timeoutMs?: number;

    sideEffects: SideEffectScope[];
    minPermission: PermissionLevel;

    /** Secret references (see SecretRef contract and D3 convention) */
    secrets?: readonly SecretRef[];

    handler: ToolHandler;
}

// ============================================================
// §2 Supply view
// ============================================================

/**
 * Tool view exposed to the model — the filtered whitelist.
 * forbidden tools never appear here; invoke still rejects any hallucinated or
 * forged call (the whitelist narrows visibility, it is not a security
 * boundary).
 */
export interface ToolSpec {
    name: string;
    description: string;
    parameters: JSONSchemaSpec;
    effectClass: EffectClass;
    /**
     * Effective tier after supply filtering: forbidden is removed; this is
     * the strictest tier of the joint effectClass + coEffects dispatch
     * (always-gated classes and trust: 'full' are clamped to gated, V8).
     */
    effectiveTier: 'auto' | 'gated';
    trust: ToolTrust;
    irreversible?: boolean;
    sideEffects: SideEffectScope[];
    minPermission: PermissionLevel;
    /** Value-level whitelist for the primary effectClass (scope-check runs across the full class set) */
    whitelist?: { paths?: string[]; hosts?: string[] };
}

// ============================================================
// §3 Invocation contract
// ============================================================

/**
 * Escalation payload. V12 semantics: only when requested is strictly wider
 * than effective (higher tier, or same tier with strictly broader scope) does
 * the justification get validated and the approval chain engage; otherwise
 * implementations MUST ignore this field entirely and proceed as a normal
 * call — no error, no downgrade, no approval, no justification check. The
 * partial-order comparison lives in the executor; expected semantics are in
 * core/src/semantics.ts.
 */
export interface EscalationPayload {
    requested: EffectRule;
    /** One-sentence justification; required only when strictly wider */
    justification: string;
}

/**
 * Invocation request.
 *
 * V11: this structure carries no identity fields (no contractId/turnId/
 * sessionId). Identity is injected by the harness at construction via
 * GatewayBindInput — the model cannot choose its identity, and privilege
 * elevation is not expressible at the type level.
 */
export interface InvocationRequest {
    /** Tool name (must be registered) */
    tool: string;
    /** Args (schema-validated at supply-check; invalid → rejected) */
    args: Record<string, unknown>;
    /** Optional escalation request (subject to escalation-short-circuit) */
    escalation?: EscalationPayload;
}

/** Handle of a pending approval. */
export type PendingHandle = string;

/** Approval settlement (injected by the approval gate via settle, never by the model). */
export type PendingSettlement =
    | { decision: 'granted' } // allowed-once: execute the original request once
    | { decision: 'rejected'; reason: string }
    | { decision: 'cancelled' };

/**
 * Invocation outcome (three states).
 *
 * Rejections must be structured and actionable — a bare permission denied is
 * the leading cause of agent retry loops (dsh evidence). hint offers a
 * narrower in-scope alternative or a "do not retry" directive.
 */
export type InvocationResult =
    | { kind: 'executed'; value: unknown; untrusted?: boolean }
    | { kind: 'pending'; handle: PendingHandle; effectClass: EffectClass; hint: string }
    | { kind: 'rejected'; code: RejectCode; hint: string; dangerRuleId?: string };

// ============================================================
// §4 Hook contract (V14 monotonic guard)
// ============================================================

export interface HookContext {
    tool: ToolSpec;
    args: Record<string, unknown>;
    projection: ValueProjection;
    identifiers: TraceIdentifiers;
}

export type HookVerdict =
    | { verdict: 'allow' }
    | { verdict: 'deny'; code: RejectCode; hint: string };

/**
 * Pre/post pipeline hooks.
 *
 * V14 monotonicity (implementations MUST guarantee): within one invocation,
 * once any hook returns deny, later hooks returning allow cannot flip the
 * outcome — deny is an absorbing state for the invocation.
 */
export interface GatewayHook {
    id: string;
    preExecute(ctx: HookContext): HookVerdict | Promise<HookVerdict>;
    /** Read-only post hook: cannot mutate the result; observation/audit only */
    postExecute?(ctx: HookContext & { result: ToolOutput }): void | Promise<void>;
}

// ============================================================
// §5 Audit contract (interface for the decision log)
// ============================================================

/**
 * Canonical pipeline stage names — implementation stage names must align so
 * audit events are comparable across runs. Stages execute in the listed order.
 *
 * Stage semantics:
 *   escalation-short-circuit — ignore the escalation field unless it is
 *       strictly wider than the effective rule (V12): no error, no downgrade,
 *       no approval.
 *   supply-check            — tool is registered, effectClass is declared, and
 *       args pass schema validation (V5 closed-world).
 *   hook-chain              — pre-execute hooks; deny is absorbing (V14).
 *   tier-dispatch           — joint dispatch over effectClass + coEffects:
 *       any forbidden → reject; the strictest tier governs
 *       (forbidden → reject / auto → execute / gated → approval).
 *   scope-check             — value-level scope checks (paths/hosts/amount):
 *       whitelist hit → pre-authorized pass-through (always-gated classes are
 *       never exempt, V8); any miss → danger-match.
 *   danger-match            — DangerRule value-level matching (command
 *       patterns / SQL predicates / sensitive paths); outcome applies.
 *   approval                — out-of-scope or high-risk → ApprovalSeam,
 *       returns pending(handle); missing seam → fail-closed rejection (V13).
 *   budget                  — steps/tokens/cost deduction; over-limit →
 *       BUDGET_EXHAUSTED (re-checked when settling).
 *   execute                 — handler runs unprivileged in the sandbox (V6);
 *       environment provisioned by the Deployer (D1–D3).
 *   output-taint            — untrustedOutput → return value tagged.
 *
 * Audit is cross-cutting: every stage emits its decision event
 * (allowed/denied/pending/info) to the sink; it is not a stage itself.
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
] as const;

export type GatewayStage = (typeof GATEWAY_PIPELINE_STAGES)[number];

export interface GatewayAuditEvent {
    stage: GatewayStage;
    /** allowed=passed denied=rejected pending=queued info=accounting */
    decision: 'allowed' | 'denied' | 'pending' | 'info';
    /** All three IDs required (v2 observability alignment); any missing is an implementation defect */
    identifiers: TraceIdentifiers;
    tool?: string;
    effectClass?: EffectClass;
    detail?: string;
    dangerRuleId?: string;
    escalation?: EscalationPayload;
}

/**
 * Decision event sink.
 *
 * emit is never blocked by feature flags (v2 principle 4: flags control only
 * whether the sink consumes). Blocked attempts must also be recorded — "what
 * the agent tried to do and was stopped from" is a first-class signal for
 * security analysis.
 */
export interface GatewayAuditSink {
    log(event: GatewayAuditEvent): void;
}

// ============================================================
// §6 Core interface
// ============================================================

/**
 * ToolGateway — one instance per Turn.
 *
 * Stateful: holds the turn's effective policy, danger rules and budget
 * counters. Discarded when the turn ends; counters do not cross turns.
 */
export interface ToolGateway {
    /** Bound Turn (identity injected; the model cannot forge it) */
    readonly turnId: string;
    /** Filtered tool whitelist (visibility narrowing, not a security boundary) */
    readonly tools: readonly ToolSpec[];

    /**
     * The single invocation entry point. Stage order follows the header
     * contract and GATEWAY_PIPELINE_STAGES. Budget counting under concurrent
     * calls must be atomic (implementation guarantee).
     */
    invoke(req: InvocationRequest): Promise<InvocationResult>;

    /**
     * pull: model-initiated pending status query.
     * undefined = unknown handle; unsettled returns a pending copy; settled
     * returns the final result. (push injection happens in the executor loop
     * at the start of the next round; both coexist, push is primary.)
     */
    checkPending(handle: PendingHandle): Promise<InvocationResult | undefined>;

    /**
     * push: injects an approval result (called by the approval gate or the
     * executor, never by the model). granted executes the original request
     * once — allowed-once semantics: approval applies to this action only and
     * never rewrites the grant (persistent permission changes only via
     * ContractRevision). The budget stage and hooks are re-checked before
     * execution. Unknown or already-settled handle → undefined.
     */
    settle(
        handle: PendingHandle,
        settlement: PendingSettlement,
    ): Promise<InvocationResult | undefined>;
}

/**
 * Factory: constructs a turn-bound instance.
 * Owned by the executor; identity in bindInput comes from the active cursor
 * of the execution loop (V11).
 */
export interface ToolGatewayFactory {
    forTurn(bind: GatewayBindInput): ToolGateway;
}

/**
 * Construction input = permission data handed off by Capacity + identity
 * injected by the harness + peripheral services.
 *
 * V2 invariant: this structure contains only effective (computed result) and
 * registry references — nothing that could let a gateway instance widen
 * permissions on its own.
 */
export interface GatewayBindInput {
    // —— identity (harness-injected; never from model output) ——
    sessionId: string;
    turnId: string;

    // —— permission data (derived artifacts; the gateway consumes, never computes) ——
    effective: EffectivePolicy;
    dangerRules: readonly AppliedDangerRule[];
    budget: Budget;
    toolRegistry: ReadonlyMap<string, ToolRegistration>;
    /** Sandbox configuration (from Capacity.sandbox; Deployer provisions D1–D3) */
    sandbox: SandboxSpec;

    // —— peripheral services ——
    /** Approval seam (L1 policy implementation); must fail-closed when absent (V13) */
    approval: ApprovalSeam;
    /** Decision event sink (emit never blocked by flags) */
    audit: GatewayAuditSink;
    /** Pre-execute hook chain (V14 monotonic guard) */
    hooks?: readonly GatewayHook[];
}

// ============================================================
// §7 Registration examples (docs; type-checked cases in __tests__/registrations.ts)
// ============================================================

/**
 * bash — a single registration covers all commands; the effect surface is
 * enforced by the sandbox (D1):
 *
 *   {
 *     name: 'bash', effectClass: 'fs.exec',
 *     parameters: { type: 'object',
 *       properties: { command: { type: 'string' } },
 *       required: ['command'] },
 *     scope: { commandParam: 'command' },
 *     trust: 'confined', sideEffects: ['process', 'fs', 'net'],
 *     handler: spawnInSandbox,
 *   }
 *
 * HTTP GET — single effect, hosts whitelist + proxy (D2):
 *
 *   {
 *     name: 'http_get', effectClass: 'net.fetch',
 *     parameters: { type: 'object',
 *       properties: { url: { type: 'string' } },
 *       required: ['url'] },
 *     scope: { hostParams: ['url'] },
 *     untrustedOutput: true, trust: 'confined', sideEffects: ['net'],
 *     handler: fetchViaProxy,
 *   }
 *
 * Payment API — multi-effect joint dispatch + secret injection:
 *
 *   {
 *     name: 'charge', effectClass: 'pay', coEffects: ['net.send'],
 *     parameters: { type: 'object',
 *       properties: { amount: { type: 'number' },
 *                     currency: { type: 'string' } },
 *       required: ['amount', 'currency'] },
 *     scope: { amountParam: 'amount', hostParams: ['endpoint'] },
 *     secrets: ['secret:merchant-key'],
 *     irreversible: true, trust: 'confined', sideEffects: ['pay', 'net'],
 *     handler: callMerchantApi,
 *   }
 *
 * MCP tool — one-to-one mapping, full-trust annotation (D3):
 *
 *   {
 *     name: 'mcp.github.create_issue', effectClass: 'publish',
 *     parameters: mcpToolSchema,
 *     trust: 'full', untrustedOutput: true,
 *     secrets: ['secret:github-token'], sideEffects: ['external-api'],
 *     handler: callMcpServer,
 *   }
 */
