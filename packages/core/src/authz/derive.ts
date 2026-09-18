/**
 * Derivation — single-direction permission tightening (V3 §6.1).
 *
 *   effective(cap) = meet(root, request) ⊔ three-question floor ⊓ hard clamp
 *
 * An undeclared capability is forbidden (closed world). The floors and the hard
 * clamp never take part in the meet and cannot be relaxed by any layer. Every
 * derivation returns an immutable snapshot that pins the annotation/rule/trust
 * versions in force at that moment.
 */

import type { AssetLabelRegistry, ResolvedLabel } from './labels.js';
import { assessQuestions } from './risk.js';
import {
    type CapabilitySpec,
    type DeriveResult,
    type EffectiveCapability,
    type EffectivePolicy,
    type Grant,
    maxLabel as maxLabelFn,
    type PinnedVersions,
    type SensitivityLabel,
    strictestTier,
    type TaskRequest,
    type ToolSemantics,
} from './types.js';

export interface DeriveContext {
    labels: AssetLabelRegistry;
    /** Capability → declared semantics (tool registration). */
    semantics?: Readonly<Record<string, ToolSemantics>>;
    pinned: PinnedVersions;
    rootId: string;
    rootVersion: number;
    taskId: string;
    /** Emergency revocation: a pinned snapshot whose version is revoked fails closed. */
    isRevoked?: (pinned: PinnedVersions) => boolean;
}

function intersectOptional(
    parent: readonly string[] | undefined,
    child: readonly string[] | undefined,
): string[] | undefined {
    if (parent === undefined) return child === undefined ? undefined : [...child];
    if (child === undefined) return [...parent];
    return parent.filter((value) => child.includes(value));
}

/** §6.1 meet: only tighten (tier, range intersection, maxLabel). */
export function meetSpec(parent: CapabilitySpec, child: CapabilitySpec): CapabilitySpec {
    const spec: CapabilitySpec = {
        tier: strictestTier(parent.tier, child.tier),
        maxLabel: maxLabelFn(parent.maxLabel ?? 'internal', child.maxLabel ?? 'internal'),
    };
    const paths = intersectOptional(parent.paths, child.paths);
    const hosts = intersectOptional(parent.hosts, child.hosts);
    if (paths !== undefined) spec.paths = paths;
    if (hosts !== undefined) spec.hosts = hosts;
    return spec;
}

function hasWildcard(path: string): boolean {
    return path.includes('*') || path.includes('?');
}

/** Reachable target inferred from the static spec (literal paths + maxLabel). */
function inferTarget(spec: CapabilitySpec, registry: AssetLabelRegistry): ResolvedLabel {
    let label: SensitivityLabel = spec.maxLabel ?? 'internal';
    let boundary = false;
    for (const path of spec.paths ?? []) {
        if (hasWildcard(path)) continue;
        const resolved = registry.resolve({ kind: 'path', value: path });
        label = maxLabelFn(label, resolved.label);
        if (resolved.boundary) boundary = true;
    }
    return { label, boundary, specificity: 0, matches: [] };
}

function buildCapability(
    key: string,
    spec: CapabilitySpec,
    ctx: DeriveContext,
): EffectiveCapability {
    const semantics: ToolSemantics = ctx.semantics?.[key] ?? {};
    const target = inferTarget(spec, ctx.labels);
    const assessment = assessQuestions({
        capability: key,
        semantics,
        projection: {},
        target,
    });
    return {
        key,
        spec,
        tier: strictestTier(spec.tier, assessment.floor, assessment.hard),
        targetLabel: target.label,
        boundary: target.boundary,
        questions: assessment.questions,
    };
}

/**
 * Derive an EffectivePolicy. Failure is fail-fast: a required capability absent
 * from the parent grant, or a revoked pinned snapshot, yields a rejection.
 */
export function derive(root: Grant, request: TaskRequest, ctx: DeriveContext): DeriveResult {
    if (ctx.isRevoked?.(ctx.pinned)) {
        return {
            ok: false,
            rejection: { code: 'DERIVE_REJECTED', hint: '钉版快照已被紧急撤销' },
        };
    }

    const missing = request.requires.filter((key) => root.caps[key] === undefined);
    if (missing.length > 0) {
        return {
            ok: false,
            rejection: {
                code: 'DERIVE_REJECTED',
                hint: `任务所需能力超出父层授权：${missing.join(', ')}`,
            },
        };
    }

    const wanted = new Set<string>([...request.requires, ...Object.keys(request.wants ?? {})]);
    const capabilities: Record<string, EffectiveCapability> = {};
    for (const key of wanted) {
        const parentSpec = root.caps[key];
        if (!parentSpec) continue;
        const wantSpec = request.wants?.[key];
        const spec = wantSpec ? meetSpec(parentSpec, wantSpec) : { ...parentSpec };
        capabilities[key] = buildCapability(key, spec, ctx);
    }

    const policy: EffectivePolicy = {
        capabilities,
        pinned: ctx.pinned,
        derivedFrom: { rootId: ctx.rootId, rootVersion: ctx.rootVersion, taskId: ctx.taskId },
    };
    return { ok: true, policy };
}
