/**
 * Authorization contract — the complete data model of the permission system.
 *
 * Permission lifecycle: grant (root signing) → derive (policy computation) →
 * enforce (call-time). This file defines the types of the first two stages;
 * the enforce-stage behavioral contract lives in tool-gateway.ts
 * (ToolGateway).
 *
 * Approval layering (see approval.ts): human-in-the-loop approvals never
 * rewrite the root grant. once/session approvals are per-task (held by the
 * ToolGateway, discarded when the task execution ends); workspace approvals
 * are held by the workspace-level container (they outlive tasks, until
 * revoked or the workspace is deleted). Persistent permission changes go
 * exclusively through ContractRevision.
 *
 * ── Open-extension conventions ─────────────────────────────────────────
 * EffectClass / EffectTier / Trigger / PermissionLevel / SideEffectScope /
 * RejectCode all end with `(string & {})` — keeping literal autocomplete and
 * discrimination while allowing platform extension. Extension semantics:
 *   - EffectClass      new tools register new effect classes; unregistered
 *                      classes fall back to forbidden via closed-world (V5),
 *                      so extension carries no security risk
 *   - EffectTier       platform tiers must provide a partial-order mapping to
 *                      the standard three tiers, otherwise the derivation
 *                      meet cannot compare them
 *   - Trigger          platform-custom escalation trigger timing
 *   - PermissionLevel  extended levels cannot be built from the standard
 *                      PRESETS; the platform must provide named grant
 *                      factories (see the positioning note on the type)
 *   - SideEffectScope  purely descriptive metadata; extension is unconstrained
 *   - RejectCode       platform codes still honor the "structured +
 *                      actionable hint" contract (prevents retry loops)
 */

// ============================================================
// §1 Permission atoms
// ============================================================

export type EffectClass =
    | 'fs.read.workspace'
    | 'fs.read.host'
    | 'fs.write.draft'
    | 'fs.write.sandbox'
    | 'fs.write.workspace'
    | 'fs.exec'
    | 'net.fetch'
    | 'net.send'
    | 'db.read'
    | 'db.write'
    | 'db.schema'
    | 'publish'
    | 'pay'
    | 'delete'
    | `external.${string}`
    | (string & {});

export type EffectTier = 'auto' | 'gated' | 'forbidden' | (string & {});
export type Trigger = 'on-failure' | 'on-request' | (string & {});

/**
 * v2 five-level semantic tiers.
 *
 * ── Positioning note ───────────────────────────────────────────────────
 * PermissionLevel is the index into the AgentGrant preset factories
 * (PRESETS), not the permission itself. Actual permission governance is
 * carried by EffectivePolicy. It is used only for:
 *   ① root-level signing of human-readable grants (makeRootGrant(level, ...))
 *   ② coarse-grained display for observability/audit/routing
 *      (inferPermissionLevel derives it back from the effective policy;
 *      consumed by tool-gateway)
 * No enforce decision may read PermissionLevel — enforce reads only
 * EffectivePolicy: the tier is an index, the rule is the substance.
 * Extended tiers (outside the standard five) cannot be built from PRESETS;
 * the platform must provide named grant factories registered at the
 * composition root.
 */
export type PermissionLevel =
    | 'text' // text-only generation, no effects
    | 'read-only' // readable, not writable
    | 'draft' // writes to the staging area
    | 'approved' // external actions after approval
    | 'autonomous' // constrained autonomy
    | (string & {});

/**
 * Side-effect domain — coarse classification annotated at tool registration.
 *
 * ── Positioning note ───────────────────────────────────────────────────
 * Purely descriptive metadata: used for observability aggregation, audit
 * classification and tool-directory lookup. It does NOT participate in
 * dispatch or enforce decisions — permission decisions recognize only
 * EffectClass; any implementation judging permissions from
 * SideEffectScope is defective.
 * Maps to (but is not equivalent to) EffectClass:
 *   fs.* → 'fs'；net.* → 'net'；fs.exec → 'process'；
 *   db.* → 'db'；pay → 'pay'；external.* → 'external-api'
 */
export type SideEffectScope =
    | 'fs'
    | 'net'
    | 'process'
    | 'db'
    | 'pay'
    | 'external-api'
    | (string & {});

// ============================================================
// §2 Rules and authorization
// ============================================================

export interface EffectRule {
    tier: EffectTier;
    trigger?: Trigger;
    paths?: string[];
    hosts?: string[];
    amountLimit?: { currency: string; amount: number };
}

export interface Budget {
    maxSteps?: number;
    maxTokens?: number;
    maxCostUsd?: number;
    timeoutMs?: number;
}

export type AgentGrant = Partial<Record<EffectClass, EffectRule>> & {
    rootContractId: string;
    version: number;
    budget?: Budget;
};

export interface TaskPolicyRequest {
    requires: EffectClass[];
    wants?: Partial<Record<EffectClass, EffectRule>>;
}

export interface EffectivePolicy {
    rules: Partial<Record<EffectClass, EffectRule>>;
    derivedFrom: { rootContractId: string; rootVersion: number; taskId: string };
}

export type DeriveResult =
    | { ok: true; policy: EffectivePolicy }
    | { ok: false; revision: { wants: EffectClass }; reason: string };

// ============================================================
// §3 Canonical constants
// ============================================================

/**
 * V8 canonical constant: always-gated classes, never exempted by whitelists.
 *
 * Scope of the V8 rule: the pre-authorization path — an effective whitelist
 * hit (scope-check) never exempts these classes. HIL approvals are a
 * different path: an explicit session/workspace approval of an always-gated
 * class is a deliberate human decision and MAY waive the gate per platform
 * semantics — but every grant and every hit must be audited (emit is never
 * blocked by feature flags).
 */
export const ALWAYS_GATED_CLASSES: readonly EffectClass[] = [
    'delete',
    'db.schema',
    'pay',
    'publish',
] as const;

// ============================================================
// §4 DangerRule (V16: does not join the meet; never relaxable at any layer)
// ============================================================

export interface DangerRule {
    id: string;
    match: {
        commandPatterns?: RegExp[];
        sqlPredicates?: string[];
        pathGlobs?: string[];
        effectClasses?: EffectClass[];
    };
    outcome: 'forbidden' | 'always-gated';
    reason: string;
}

export interface AppliedDangerRule {
    ruleId: string;
    outcome: 'forbidden' | 'always-gated';
    reason: string;
    appliesTo: EffectClass[];
}

// ============================================================
// §5 Dangerous-combination guard (one of the only legitimate uses of a Guard)
// ============================================================

export interface GuardRule {
    id: string;
    when: (p: EffectivePolicy) => boolean;
    downgrade: Partial<Record<EffectClass, EffectTier>>;
    reason: string;
}

// ============================================================
// §6 Reject codes (structured, prevents retry loops)
// ============================================================

/**
 * A bare permission denied is the leading cause of agent retry loops —
 * rejections must be structured and actionable. Platform extension codes
 * still honor this contract and provide an actionable hint.
 */
export type RejectCode =
    | 'FORBIDDEN_UNREGISTERED'
    | 'FORBIDDEN_BY_POLICY'
    | 'FORBIDDEN_BY_DANGER_RULE'
    | 'GATED_PENDING'
    | 'GATED_REJECTED'
    | 'BUDGET_EXHAUSTED'
    | 'SANDBOX_UNAVAILABLE'
    | 'APPROVAL_UNAVAILABLE'
    | (string & {});
