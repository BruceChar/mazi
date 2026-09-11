/**
 * Authorization v2 — shared data types.
 *
 * Implements the data semantics of AHF_CORE_AUTHORIZATION_V2.md §4. The
 * enforce-stage behavior (11-stage pipeline) lives in the ToolGateway doc;
 * this module is the policy/computation layer it consumes.
 */

// ============================================================
// §4.1 Domain
// ============================================================

export type Domain = 'sandbox' | 'workspace' | 'host' | 'external';

export const DOMAINS: readonly Domain[] = ['sandbox', 'workspace', 'host', 'external'] as const;

// ============================================================
// §4.2 Label
// ============================================================

export type SensitivityLabel = 'public' | 'internal' | 'sensitive' | 'secret';

/** Strictness ranking; higher is more sensitive. Absence of annotation = internal (P13/N1). */
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

/** Monotonic dataflow-ledger version (N8). */
export type LedgerVersion = number;

export type AssetKind = 'path' | 'db' | 'host' | 'env' | 'registry' | 'topic';

export type LabelOrigin = 'platform' | 'user' | 'platform-curated-negative';

export interface AssetLabel {
    kind: AssetKind;
    /** Glob / FQN / domain wildcard. */
    pattern: string;
    label: SensitivityLabel;
    /** Permission-envelope asset → R5 (boundary ∪). */
    boundary?: boolean;
    /** Pattern concreteness: count of non-wildcard characters. Filled by normalizeLabel. */
    specificity?: number;
    /** v1.3: platform-curated negative entries are the low-cost secret-downgrade outlet (B1). */
    origin: LabelOrigin;
}

export interface AssetQuery {
    kind: AssetKind;
    value: string;
}

/** One suppressed user downgrade declaration (audit-first-class, N15/B3). */
export interface LabelResolutionEvent {
    reason: 'user-downgrade-suppressed';
    kind: AssetKind;
    asset: string;
    userLabel: SensitivityLabel;
    enforcedLabel: SensitivityLabel;
}

export interface ResolvedLabel {
    label: SensitivityLabel;
    boundary: boolean;
    specificity: number;
    matches: AssetLabel[];
    suppressed: LabelResolutionEvent[];
    /** True when the resolved label was tightened by the derived-label overlay (flow layer only, P24). */
    fromOverlay: boolean;
}

/** v1.3 derived-label overlay; cap is sensitive (A1b). */
export interface DerivedLabel {
    target: string;
    label: 'sensitive';
    derivedFrom: string[];
    lifetime: 'manual-clear' | 'sandbox-teardown';
    createdAt: LedgerVersion;
}

export interface DerivedLabelClearEvent {
    attestor: string;
    target: string;
    reason: string;
}

// ============================================================
// §4.3 Role
// ============================================================

export type Transfer = 'none' | 'ingest' | 'egress';
export type Commit = 'reversible' | 'recoverable' | 'committed';
export type Opacity = 'transparent' | 'opaque';
export type ReversibilityEvidence = 'domain-teardown' | 'task-scratch';

export interface Role {
    transfer: Transfer;
    commit: Commit;
    opacity: Opacity;
    /** Conjunctive credential for commit: reversible (the mechanism, not a promise). */
    reversibleBy?: ReversibilityEvidence;
}

/** Backend capability matrix (V15): which reversibility credentials the backend can actually enforce. */
export interface BackendCapabilities {
    id: string;
    supportsReversibility: readonly ReversibilityEvidence[];
    /** Axes the backend cannot enforce (V15 cap: forbidden by default, or gated+disclosure). */
    unenforced?: readonly UnenforcedAxis[];
}

export type UnenforcedAxis = 'fs.read.host' | 'net' | 'fs.exec';

export interface UnenforcedAxisPolicy {
    axis: UnenforcedAxis;
    mode: 'forbidden' | 'gated';
}

// ============================================================
// §5.1 Grant and request
// ============================================================

export type EffectTier = 'auto' | 'gated' | 'forbidden';
export type Trigger = 'on-failure' | 'on-request' | 'predeclare';

/** `action.domain` string key, e.g. 'fs.write.workspace'. */
export type CapabilityKey = string;

export interface Money {
    currency: string;
    amount: number;
}

/** How a sensitive source drains before returning (R3-hard/§6.2 source severance). */
export type SeveranceMode = 'plain' | 'redacted' | 'handle';

export interface CapabilityRule {
    action: string;
    domain: Domain;
    /** Declared tier intent (joins the meet). */
    tier: EffectTier;
    trigger?: Trigger;
    paths?: string[];
    hosts?: string[];
    amountLimit?: Money;
    /** Highest reachable sensitivity; default internal (P13). */
    maxLabel?: SensitivityLabel;
    /** draft qualifier, paired with the task-scratch reversibility credential. */
    scope?: 'task-scratch';
    /** Declared role (tool registration); drives R1/R2/R4/R6. */
    role?: Role;
    /** Source severance for ingest capabilities; `plain` on a secret source is forbidden (R3-hard). */
    severance?: SeveranceMode;
}

export interface Budget {
    steps?: number;
    tokens?: number;
    cost?: number;
}

export type AgentGrant = Partial<Record<CapabilityKey, CapabilityRule>> & {
    budget?: Budget;
};

export interface TaskPolicyRequest {
    requires: CapabilityKey[];
    wants?: Partial<Record<CapabilityKey, CapabilityRule>>;
}

// ============================================================
// §5.3 Effective snapshot
// ============================================================

export type RuleId =
    | 'R1'
    | 'R2'
    | 'R3-hard'
    | 'R3-flow'
    | 'R4'
    | 'R5'
    | 'R6'
    | 'V17'
    | 'V13'
    | 'V15';

export interface RuleHit {
    rule: RuleId;
    capability: CapabilityKey;
    /** TCB source version that produced the hit (T1 attribution). */
    sourceVersion: number;
    detail?: string;
}

/** R3-flow runtime predicate attached to a sink; a snapshot ingredient, never written back to a grant (N5). */
export interface ConditionPredicate {
    id: string;
    kind: 'no-sensitive-ingest';
    capability: CapabilityKey;
    description: string;
}

export interface GuardPair {
    source: CapabilityKey;
    sink: CapabilityKey;
    mode: 'hard' | 'flow';
}

export interface PinnedVersions {
    labels: number;
    roles: number;
    rules: number;
    rootTrust: number;
}

export interface EffectiveCapability {
    key: CapabilityKey;
    rule: CapabilityRule;
    /** Effective role (credentials resolved, §4.3); drives R3 pair classification. */
    role: Role;
    /** Reachable target sensitivity / boundary for this capability. */
    targetLabel: SensitivityLabel;
    boundary: boolean;
    /** meet of declared wills (V3). */
    meetTier: EffectTier;
    /** after rule floors + hard layer + backend cap. */
    tier: EffectTier;
    floors: RuleHit[];
    conditions: ConditionPredicate[];
}

export interface EffectivePolicy {
    capabilities: Record<CapabilityKey, EffectiveCapability>;
    ruleHits: RuleHit[];
    conditions: ConditionPredicate[];
    guardPairs: GuardPair[];
    pinned: PinnedVersions;
    ledgerDomain: 'context-generation' | 'session';
    derivedFrom: { rootContractId: string; rootVersion: number; taskId: string };
}

export interface ContractRevision {
    id: string;
    /** Capabilities the task requires that the parent cannot supply. */
    requires: CapabilityKey[];
    wants?: Partial<Record<CapabilityKey, CapabilityRule>>;
    justification: string;
    requestedBy: string;
    /** true = two-person sign-off required (default for high-risk classes). */
    dualApproval: boolean;
    fastTrack: boolean;
}

export interface DeriveRejection {
    reason: string;
    revision: ContractRevision;
}

export type DeriveResult =
    | { ok: true; policy: EffectivePolicy }
    | { ok: false; rejection: DeriveRejection };

// ============================================================
// §13/V15 error codes
// ============================================================

export type AuthzErrorCode =
    | 'FORBIDDEN_UNREGISTERED'
    | 'FORBIDDEN_BY_POLICY'
    | 'FORBIDDEN_BY_HARD_LAYER'
    | 'GATED_PENDING'
    | 'APPROVAL_UNAVAILABLE'
    | 'SANDBOX_UNAVAILABLE'
    | 'POLICY_REVOKED'
    | 'LEDGER_BARRIER_TIMEOUT'
    | 'LEDGER_UNAVAILABLE'
    | 'HANDLE_REFUSED'
    | 'HANDLE_UNRESOLVABLE'
    | 'SIGN_POLICY_VIOLATION'
    | 'SIGN_MAX_USES_EXCEEDED'
    | 'TOKEN_REVOKED'
    | 'REFERENCE_DRIFT'
    | 'EGRESS_SENSITIVE'
    | 'DERIVE_REJECTED';

export interface AuthzRejection {
    code: AuthzErrorCode;
    hint: string;
}
