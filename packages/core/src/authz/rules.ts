/**
 * R1–R6 lower-bound evaluators and the P24 precedence lattice (§4.4/§4.5).
 *
 * Ordering: hard layer > derived overlay (flow only) > rule lower bounds >
 * meet. Lower bounds and the hard layer never take part in the meet (V8):
 * any layer may tighten, none may relax.
 */

import { isCommitted, isEgress, isOpaque, isReversible } from './roles.js';
import type {
    AuthzRejection,
    BackendCapabilities,
    CapabilityKey,
    CapabilityRule,
    EffectTier,
    Role,
    RuleHit,
    SensitivityLabel,
    UnenforcedAxis,
    UnenforcedAxisPolicy,
} from './types.js';

export const TIER_RANK: Readonly<Record<EffectTier, number>> = {
    auto: 0,
    gated: 1,
    forbidden: 2,
};

export function strictestTier(...tiers: readonly EffectTier[]): EffectTier {
    let result: EffectTier = 'auto';
    for (const tier of tiers) {
        if (TIER_RANK[tier] > TIER_RANK[result]) result = tier;
    }
    return result;
}

const WRITE_ACTIONS = new Set(['delete', 'db.write', 'db.schema', 'publish', 'pay']);

/** True when the capability mutates a target asset (R5 boundary check). */
export function isWriteAction(action: string): boolean {
    if (WRITE_ACTIONS.has(action)) return true;
    return action.includes('write');
}

export interface LowerBoundInput {
    capability: CapabilityKey;
    rule: CapabilityRule;
    /** meet result from the derivation layers. */
    meetTier: EffectTier;
    /** effective role (credentials resolved, §4.3). */
    role: Role;
    targetLabel?: SensitivityLabel;
    boundary?: boolean;
    /** True when the resolved target label came from the derived overlay. */
    fromOverlay?: boolean;
    sourceVersion: number;
}

export interface LowerBoundResult {
    floor: EffectTier;
    hits: RuleHit[];
}

function hit(
    rule: RuleHit['rule'],
    capability: CapabilityKey,
    sourceVersion: number,
    detail?: string,
): RuleHit {
    return { rule, capability, sourceVersion, detail };
}

/**
 * R1/R2/R4/R5/R6 evaluated per capability. R3 is a pair rule and lives in the
 * full-pair guard (derive.ts); the hard layer is evaluated separately so the
 * overlay can never reach it (P24).
 */
export function evaluateLowerBounds(input: LowerBoundInput): LowerBoundResult {
    const { capability, rule, role, boundary, sourceVersion } = input;
    const hits: RuleHit[] = [];
    let floor: EffectTier = 'auto';

    if (isCommitted(role)) {
        floor = strictestTier(floor, 'gated');
        hits.push(hit('R1', capability, sourceVersion, 'commit=committed'));
    }
    if (isEgress(role)) {
        floor = strictestTier(floor, 'gated');
        hits.push(hit('R2', capability, sourceVersion, 'transfer=egress'));
    }
    if (isOpaque(role)) {
        floor = strictestTier(floor, 'gated');
        hits.push(hit('R4', capability, sourceVersion, 'opacity=opaque: worst-role floor'));
    }
    if (boundary === true && isWriteAction(rule.action)) {
        floor = strictestTier(floor, 'gated');
        hits.push(hit('R5', capability, sourceVersion, 'boundary-write'));
    }
    if (isReversible(role)) {
        // R6 does not force a floor; it records that the credential makes auto
        // legitimate. The meet tier still governs (only tighten, never relax).
        hits.push(
            hit('R6', capability, sourceVersion, `reversible-by:${role.reversibleBy ?? 'none'}`),
        );
    }

    return { floor, hits };
}

export interface HardLayerInput {
    capability: CapabilityKey;
    rule: CapabilityRule;
    /** Static annotation only — the derived overlay must NOT be passed here (P24). */
    staticLabel?: SensitivityLabel;
    sourceVersion: number;
}

export interface HardLayerResult {
    hard: EffectTier;
    hits: RuleHit[];
}

/**
 * Hard layer (V17). Triggered solely by static annotations; forbidden is not
 * exemptible by any tier, whitelist or configuration (V8/V17).
 */
export function applyHardLayer(input: HardLayerInput): HardLayerResult {
    const { capability, rule, staticLabel, sourceVersion } = input;
    if (staticLabel === 'secret' && isWriteAction(rule.action)) {
        return {
            hard: 'forbidden',
            hits: [hit('V17', capability, sourceVersion, 'secret-write-forbidden')],
        };
    }
    return { hard: 'auto', hits: [] };
}

/** Effective tier = hard ⊔ floors ⊔ meet (P24 precedence). */
export function resolveCapabilityTier(
    meetTier: EffectTier,
    floor: EffectTier,
    hard: EffectTier,
): EffectTier {
    return strictestTier(meetTier, floor, hard);
}

export function unenforcedAxisFor(rule: CapabilityRule): UnenforcedAxis | undefined {
    if (rule.action === 'fs.read' && rule.domain === 'host') return 'fs.read.host';
    if (rule.action === 'fs.exec') return 'fs.exec';
    if (rule.action.startsWith('net') || rule.domain === 'external') return 'net';
    return undefined;
}

export interface BackendCapInput {
    capability: CapabilityKey;
    rule: CapabilityRule;
    tier: EffectTier;
    backend: BackendCapabilities;
    /** Deployment-chosen policy; default is forbidden (V15). */
    unenforcedPolicy?: readonly UnenforcedAxisPolicy[];
    sourceVersion: number;
}

export interface BackendCapResult {
    tier: EffectTier;
    hits: RuleHit[];
    /** Mandatory disclosure when a gated unenforced axis is approved (V15). */
    disclosure?: string;
}

export const UNENFORCED_AXIS_DISCLOSURE =
    '此轴无内核强制，批准范围 ≠ 实际可达范围；handler 进程内可绕过 args 声明的路径';

export function applyBackendCap(input: BackendCapInput): BackendCapResult {
    const axis = unenforcedAxisFor(input.rule);
    if (!axis || !input.backend.unenforced?.includes(axis)) {
        return { tier: input.tier, hits: [] };
    }
    const policy = input.unenforcedPolicy?.find((p) => p.axis === axis) ?? {
        axis,
        mode: 'forbidden' as const,
    };
    if (policy.mode === 'forbidden') {
        return {
            tier: 'forbidden',
            hits: [hit('V15', input.capability, input.sourceVersion, `unenforced-axis:${axis}`)],
        };
    }
    return {
        tier: strictestTier(input.tier, 'gated'),
        hits: [hit('V15', input.capability, input.sourceVersion, `unenforced-axis:${axis}:gated`)],
        disclosure: UNENFORCED_AXIS_DISCLOSURE,
    };
}

/**
 * V13 fail-closed: an absent sandbox / approval / proxy / ledger / secret
 * resolution rejects rather than proceeding. Kept here so every caller uses a
 * structured, actionable rejection.
 */
export function failClosed(code: AuthzRejection['code'], hint: string): AuthzRejection {
    return { code, hint };
}
