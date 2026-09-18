/**
 * Authorization v3 — shared data types.
 *
 * Implements the data semantics of AHF_CORE_AUTHORIZATION_V3.md: the three-question
 * risk model, single-direction permission tightening and the immutable derivation
 * snapshot. The enforce-stage behavior lives in the execution gateway.
 */

// ============================================================
// §5.3 Domain and label
// ============================================================

export type Domain = 'sandbox' | 'workspace' | 'host' | 'external';

/** Monotonic dataflow-ledger version. */
export type LedgerVersion = number;

export type SensitivityLabel = 'public' | 'internal' | 'sensitive' | 'secret';

/** Strictness ranking; higher is more sensitive. Absence of annotation = internal. */
export const LABEL_RANK: Readonly<Record<SensitivityLabel, number>> = {
    public: 0,
    internal: 1,
    sensitive: 2,
    secret: 3,
} as const;

export function maxLabel(a: SensitivityLabel, b: SensitivityLabel): SensitivityLabel {
    return LABEL_RANK[a] >= LABEL_RANK[b] ? a : b;
}

export function isAtLeastSensitive(label: SensitivityLabel): boolean {
    return LABEL_RANK[label] >= LABEL_RANK.sensitive;
}

// ============================================================
// §6.1 Capability tier and grant
// ============================================================

export type EffectTier = 'auto' | 'gated' | 'forbidden';

export const TIER_RANK: Readonly<Record<EffectTier, number>> = {
    auto: 0,
    gated: 1,
    forbidden: 2,
} as const;

export function strictestTier(...tiers: readonly EffectTier[]): EffectTier {
    let result: EffectTier = 'auto';
    for (const tier of tiers) {
        if (TIER_RANK[tier] > TIER_RANK[result]) result = tier;
    }
    return result;
}

export interface CapabilitySpec {
    /** Declared tier intent; joins the meet. */
    tier: EffectTier;
    /** Range whitelist; intersect on derive. */
    paths?: string[];
    hosts?: string[];
    /** Highest reachable sensitivity; default internal. */
    maxLabel?: SensitivityLabel;
}

export interface Budget {
    steps?: number;
    tokens?: number;
    cost?: number;
}

/** Root-layer grant (signed once by a human). Only root may create one. */
export interface Grant {
    caps: Record<string, CapabilitySpec>;
    budget?: Budget;
}

/** Task-layer request: holds only a request right, never a grant field. */
export interface TaskRequest {
    requires: string[];
    wants?: Record<string, CapabilitySpec>;
}

// ============================================================
// §6.1 Effective snapshot
// ============================================================

export interface PinnedVersions {
    labels: number;
    rules: number;
    trust: number;
}

export type Question = 'Q1' | 'Q2' | 'Q3';

export interface QuestionHit {
    question: Question;
    capability: string;
    reason: string;
}

export interface EffectiveCapability {
    key: string;
    spec: CapabilitySpec;
    /** After meet + three-question floors + hard clamp. */
    tier: EffectTier;
    /** Reachable target sensitivity / boundary for this capability. */
    targetLabel: SensitivityLabel;
    boundary: boolean;
    questions: QuestionHit[];
}

export interface EffectivePolicy {
    capabilities: Record<string, EffectiveCapability>;
    /** Immutable snapshot pins the TCB versions it was derived with. */
    pinned: PinnedVersions;
    derivedFrom: { rootId: string; rootVersion: number; taskId: string };
}

export type AuthzErrorCode =
    | 'FORBIDDEN_UNREGISTERED'
    | 'FORBIDDEN_BY_POLICY'
    | 'FORBIDDEN_BY_HARD_FLOOR'
    | 'INVALID_ARGS'
    | 'GATED_PENDING'
    | 'GATED_REJECTED'
    | 'APPROVAL_UNAVAILABLE'
    | 'BUDGET_EXHAUSTED'
    | 'EXECUTION_FAILED'
    | 'SANDBOX_UNAVAILABLE'
    | 'LEDGER_UNAVAILABLE'
    | 'EGRESS_BLOCKED'
    | 'HANDLE_REFUSED'
    | 'HANDLE_PASSTHROUGH'
    | 'SIGN_POLICY_VIOLATION'
    | 'REFERENCE_DRIFT'
    | 'DERIVE_REJECTED';

export interface AuthzRejection {
    code: AuthzErrorCode;
    hint: string;
}

export interface DeriveRejection {
    code: AuthzErrorCode;
    hint: string;
}

export type DeriveResult =
    | { ok: true; policy: EffectivePolicy }
    | { ok: false; rejection: DeriveRejection };

// ============================================================
// Value layer
// ============================================================

/** Runtime values extracted from args by the registration's scope projection. */
export interface ValueProjection {
    path?: string;
    host?: string;
    command?: string;
    sql?: string;
    amount?: { currency: string; amount: number };
}

/**
 * Tool semantic annotation (M1 declaration format). Each flag is the carrier of
 * one question: Q2 ingest, Q1 irreversible, Q3 envelope. Value-layer judgement
 * (danger verbs, boundary targets) can only tighten a declared answer.
 */
export interface ToolSemantics {
    /** Q2: the operation puts content into the model context (read / fetch / receive). */
    ingest?: boolean;
    /** Q1: the consequence is irreversible at the current point in time. */
    irreversible?: boolean;
    /** Q3: the operation modifies the permission envelope itself. */
    envelope?: boolean;
    /** Egress: the ledger must be adjudicated before execution. */
    egress?: boolean;
    /** Secret-level ingest returns a voucher instead of the plaintext (mechanism 2). */
    severance?: boolean;
    /** The tool's value layer may move data outside the workspace. */
    dataEgress?: boolean;
}
