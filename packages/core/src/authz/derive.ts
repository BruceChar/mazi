/**
 * PolicyResolver — task derivation (§5).
 *
 * `derive(parent, request, ctx)` computes the immutable EffectivePolicy
 * snapshot consumed by the ToolGateway: meet of declared wills, rule lower
 * bounds (R1/R2/R4/R5/R6), the full-pair R3 guard (hard/flow), the V17 hard
 * layer and the V15 backend cap. Every clamp/condition attach records a
 * `ruleHit`; the snapshot pins the TCB and root-trust versions.
 */

import { makeRevision } from './boundary.js';
import type { AssetLabelRegistry } from './labels.js';
import {
    isEgress,
    isIngest,
    type RoleRegistry,
    resolveEffectiveRole,
    WORST_ROLE,
} from './roles.js';
import {
    applyBackendCap,
    applyHardLayer,
    evaluateLowerBounds,
    resolveCapabilityTier,
    strictestTier,
} from './rules.js';
import {
    type AgentGrant,
    type BackendCapabilities,
    type CapabilityKey,
    type CapabilityRule,
    type ConditionPredicate,
    type DeriveResult,
    type EffectiveCapability,
    type EffectivePolicy,
    type GuardPair,
    maxLabel as maxLabelFn,
    type PinnedVersions,
    type Role,
    type RuleHit,
    type SensitivityLabel,
    type TaskPolicyRequest,
    type UnenforcedAxisPolicy,
} from './types.js';

export interface DeriveContext {
    rootContractId: string;
    rootVersion: number;
    taskId: string;
    roles: RoleRegistry;
    backend: BackendCapabilities;
    labelRegistry: AssetLabelRegistry;
    pinned: PinnedVersions;
    ledgerDomain?: 'context-generation' | 'session';
    /** 'strict' deployment: sensitive sources are also statically clamped (R3-hard). */
    strict?: boolean;
    unenforcedPolicy?: readonly UnenforcedAxisPolicy[];
    /** Override target inference (per-capability reachable label/boundary). */
    resolveTarget?: (
        capability: CapabilityKey,
        rule: CapabilityRule,
    ) => { label: SensitivityLabel; boundary: boolean };
    /** Emergency revocation: a pinned snapshot whose version is revoked fails closed. */
    isRevoked?: (pinned: PinnedVersions) => boolean;
    revisionId?: string;
}

const TRIGGER_CONSERVATISM: Readonly<Record<string, number>> = {
    predeclare: 0,
    'on-failure': 1,
    'on-request': 2,
};

function conservativeTrigger(a: CapabilityRule, b: CapabilityRule): CapabilityRule['trigger'] {
    const left = a.trigger ?? 'on-failure';
    const right = b.trigger ?? 'on-failure';
    return (
        TRIGGER_CONSERVATISM[left] >= TRIGGER_CONSERVATISM[right] ? left : right
    ) as CapabilityRule['trigger'];
}

function intersectOptional(
    parent: readonly string[] | undefined,
    child: readonly string[] | undefined,
): string[] | undefined {
    if (parent === undefined) return child === undefined ? undefined : [...child];
    if (child === undefined) return [...parent];
    return parent.filter((value) => child.includes(value));
}

function meetAmount(
    a: CapabilityRule['amountLimit'],
    b: CapabilityRule['amountLimit'],
): CapabilityRule['amountLimit'] {
    if (!a) return b;
    if (!b) return a;
    if (a.currency !== b.currency) return a;
    return { currency: a.currency, amount: Math.min(a.amount, b.amount) };
}

const SEVERANCE_STRICTNESS: Readonly<Record<string, number>> = {
    plain: 0,
    redacted: 1,
    handle: 2,
};

function stricterSeverance(
    a: CapabilityRule['severance'],
    b: CapabilityRule['severance'],
): CapabilityRule['severance'] {
    const left = a ?? 'plain';
    const right = b ?? 'plain';
    return SEVERANCE_STRICTNESS[left] >= SEVERANCE_STRICTNESS[right] ? left : right;
}

/** §5.2 meet: only tighten. */
export function meetRule(parent: CapabilityRule, child: CapabilityRule): CapabilityRule {
    return {
        action: child.action ?? parent.action,
        domain: child.domain ?? parent.domain,
        tier: strictestTier(parent.tier, child.tier),
        trigger: conservativeTrigger(parent, child),
        paths: intersectOptional(parent.paths, child.paths),
        hosts: intersectOptional(parent.hosts, child.hosts),
        amountLimit: meetAmount(parent.amountLimit, child.amountLimit),
        maxLabel: maxLabelFn(parent.maxLabel ?? 'internal', child.maxLabel ?? 'internal'),
        scope: child.scope ?? parent.scope,
        role: child.role ?? parent.role,
        severance: stricterSeverance(parent.severance, child.severance),
    };
}

function hasWildcard(path: string): boolean {
    return path.includes('*') || path.includes('?');
}

function inferTarget(
    rule: CapabilityRule,
    registry: AssetLabelRegistry,
): { label: SensitivityLabel; boundary: boolean } {
    let label = rule.maxLabel ?? 'internal';
    let boundary = false;
    for (const path of rule.paths ?? []) {
        if (hasWildcard(path)) continue;
        const resolved = registry.resolve({ kind: 'path', value: path });
        label = maxLabelFn(label, resolved.label);
        if (resolved.boundary) boundary = true;
    }
    return { label, boundary };
}

interface BuiltCapability {
    capability: EffectiveCapability;
    hits: RuleHit[];
}

function buildCapability(
    key: CapabilityKey,
    rule: CapabilityRule,
    ctx: DeriveContext,
): BuiltCapability {
    const role: Role = ctx.roles.roleOf(key) ?? rule.role ?? WORST_ROLE;
    const effectiveRole = resolveEffectiveRole(role, ctx.backend);
    const target = ctx.resolveTarget?.(key, rule) ?? inferTarget(rule, ctx.labelRegistry);
    const sourceVersion = ctx.pinned.rules;

    const lower = evaluateLowerBounds({
        capability: key,
        rule,
        meetTier: rule.tier,
        role: effectiveRole,
        targetLabel: target.label,
        boundary: target.boundary,
        sourceVersion,
    });
    const hard = applyHardLayer({
        capability: key,
        rule,
        staticLabel: target.label,
        sourceVersion,
    });
    const capped = applyBackendCap({
        capability: key,
        rule,
        tier: resolveCapabilityTier(rule.tier, lower.floor, hard.hard),
        backend: ctx.backend,
        unenforcedPolicy: ctx.unenforcedPolicy,
        sourceVersion,
    });

    const capability: EffectiveCapability = {
        key,
        rule,
        role: effectiveRole,
        targetLabel: target.label,
        boundary: target.boundary,
        meetTier: rule.tier,
        tier: capped.tier,
        floors: [...lower.hits, ...hard.hits, ...capped.hits],
        conditions: [],
    };
    return { capability, hits: capability.floors };
}

function conditionFor(sink: CapabilityKey): ConditionPredicate {
    return {
        id: `${sink}:no-sensitive-ingest`,
        kind: 'no-sensitive-ingest',
        capability: sink,
        description: '本世代账本无 ≥sensitive 读',
    };
}

function ruleHit(
    rule: RuleHit['rule'],
    capability: CapabilityKey,
    sourceVersion: number,
    detail?: string,
): RuleHit {
    return { rule, capability, sourceVersion, detail };
}

/**
 * Full-pair guard (§5.4): for every (ingest source, egress sink) pair inside
 * the effective policy. secret → R3-hard; sensitive → R3-flow condition;
 * ≤internal → no guard.
 */
function applyFullPairGuard(
    capabilities: Record<CapabilityKey, EffectiveCapability>,
    strict: boolean,
    sourceVersion: number,
    ruleHits: RuleHit[],
    conditions: ConditionPredicate[],
    guardPairs: GuardPair[],
): void {
    const entries = Object.values(capabilities);
    const sources = entries.filter((c) => isIngest(c.role));
    const sinks = entries.filter((c) => isEgress(c.role));

    for (const source of sources) {
        const label = source.targetLabel;
        const severed = (source.rule.severance ?? 'plain') !== 'plain';
        const hardSource = label === 'secret' || (strict && label === 'sensitive');
        if (hardSource && !severed) {
            source.tier = 'forbidden';
            const hit = ruleHit(
                'R3-hard',
                source.key,
                sourceVersion,
                label === 'secret'
                    ? 'secret-source-not-severed'
                    : 'strict-sensitive-source-not-severed',
            );
            pushUnique(source.floors, hit);
            ruleHits.push(hit);
        }
    }

    for (const sink of sinks) {
        for (const source of sources) {
            const label = source.targetLabel;
            const hardPair = label === 'secret' || (strict && label === 'sensitive');
            if (hardPair) {
                sink.tier = strictestTier(sink.tier, 'gated');
                const hit = ruleHit(
                    'R3-hard',
                    sink.key,
                    sourceVersion,
                    `${label}-source:${source.key}`,
                );
                pushUnique(sink.floors, hit);
                ruleHits.push(hit);
                guardPairs.push({ source: source.key, sink: sink.key, mode: 'hard' });
            } else if (label === 'sensitive') {
                const hit = ruleHit(
                    'R3-flow',
                    sink.key,
                    sourceVersion,
                    `sensitive-source:${source.key}`,
                );
                pushUnique(sink.floors, hit);
                ruleHits.push(hit);
                pushUniqueCondition(sink, conditionFor(sink.key), conditions);
                guardPairs.push({ source: source.key, sink: sink.key, mode: 'flow' });
            }
        }
    }
}

function pushUnique(list: RuleHit[], hit: RuleHit): void {
    if (!list.some((h) => h.rule === hit.rule && h.detail === hit.detail)) list.push(hit);
}

function pushUniqueCondition(
    capability: EffectiveCapability,
    condition: ConditionPredicate,
    all: ConditionPredicate[],
): void {
    if (!capability.conditions.some((c) => c.id === condition.id)) {
        capability.conditions.push(condition);
    }
    if (!all.some((c) => c.id === condition.id)) all.push(condition);
}

/**
 * Derive an EffectivePolicy. Failure is fail-fast: required-but-missing
 * capabilities produce a ContractRevision instead of spawning (P2).
 */
export function derive(
    parent: AgentGrant,
    request: TaskPolicyRequest,
    ctx: DeriveContext,
): DeriveResult {
    if (ctx.isRevoked?.(ctx.pinned)) {
        return {
            ok: false,
            rejection: {
                reason: 'POLICY_REVOKED',
                revision: makeRevision(
                    request,
                    '钉版快照已被紧急撤销',
                    ctx.taskId,
                    ctx.labelRegistry,
                    parent,
                    ctx.revisionId ?? `revision:${ctx.taskId}`,
                ),
            },
        };
    }

    const missing = request.requires.filter((key) => parent[key] === undefined);
    if (missing.length > 0) {
        return {
            ok: false,
            rejection: {
                reason: 'DERIVE_REJECTED',
                revision: makeRevision(
                    { ...request, requires: missing },
                    '任务所需能力超出父层授权',
                    ctx.taskId,
                    ctx.labelRegistry,
                    parent,
                    ctx.revisionId ?? `revision:${ctx.taskId}`,
                ),
            },
        };
    }

    const wanted = new Set<CapabilityKey>([
        ...request.requires,
        ...Object.keys(request.wants ?? {}),
    ]);
    const capabilities: Record<CapabilityKey, EffectiveCapability> = {};
    const ruleHits: RuleHit[] = [];
    const conditions: ConditionPredicate[] = [];
    const guardPairs: GuardPair[] = [];

    for (const key of wanted) {
        const parentRule = parent[key];
        if (!parentRule) continue;
        const wantRule = request.wants?.[key];
        const rule = wantRule ? meetRule(parentRule, wantRule) : { ...parentRule };
        const built = buildCapability(key, rule, ctx);
        capabilities[key] = built.capability;
        for (const hit of built.hits) ruleHits.push(hit);
    }

    applyFullPairGuard(
        capabilities,
        ctx.strict === true,
        ctx.pinned.rules,
        ruleHits,
        conditions,
        guardPairs,
    );

    const policy: EffectivePolicy = {
        capabilities,
        ruleHits,
        conditions,
        guardPairs,
        pinned: ctx.pinned,
        ledgerDomain: ctx.ledgerDomain ?? 'context-generation',
        derivedFrom: {
            rootContractId: ctx.rootContractId,
            rootVersion: ctx.rootVersion,
            taskId: ctx.taskId,
        },
    };
    return { ok: true, policy };
}
