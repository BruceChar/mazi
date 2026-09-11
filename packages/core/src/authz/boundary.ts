/**
 * Boundary-asset checks and ContractRevision assessment (§7.3, §12 N19).
 *
 * A boundary asset is a permission-envelope write: identity persistence,
 * execution persistence, supply-chain hooks, tool-config persistence and the
 * harness self-envelope. Writes are R5-gated; secret boundary assets are V17
 * forbidden.
 */

import { matchGlob, normalizeAssetPath } from './glob.js';
import type { AssetLabelRegistry } from './labels.js';
import type {
    AgentGrant,
    AssetLabel,
    CapabilityRule,
    ContractRevision,
    Money,
    TaskPolicyRequest,
} from './types.js';

export interface BoundaryMatchOptions {
    home?: string;
}

function labelMatchesPath(
    labels: readonly AssetLabel[],
    path: string,
    home: string | undefined,
): boolean {
    const value = normalizeAssetPath(path, home);
    return labels.some((label) => matchGlob(normalizeAssetPath(label.pattern, home), value));
}

/** True when any candidate path lands on (or is contained by) a boundary asset. */
export function pathsIntersectBoundary(
    paths: readonly string[] | undefined,
    registry: AssetLabelRegistry,
    opts: BoundaryMatchOptions = {},
): boolean {
    if (!paths || paths.length === 0) return false;
    const boundaryLabels = registry.labels.filter((l) => l.boundary === true);
    return paths.some((p) => labelMatchesPath(boundaryLabels, p, opts.home ?? registry.home));
}

/** True when any candidate path lands on a platform secret annotation. */
export function pathsIntersectSecret(
    paths: readonly string[] | undefined,
    registry: AssetLabelRegistry,
    opts: BoundaryMatchOptions = {},
): boolean {
    if (!paths || paths.length === 0) return false;
    const secretLabels = registry.labels.filter(
        (l) => l.label === 'secret' && l.origin === 'platform',
    );
    return paths.some((p) => labelMatchesPath(secretLabels, p, opts.home ?? registry.home));
}

export interface RevisionAssessment {
    dualApproval: boolean;
    fastTrack: boolean;
    reasons: string[];
}

function amountsEqual(a: Money | undefined, b: Money | undefined): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return a.currency === b.currency && a.amount === b.amount;
}

function ruleUnchanged(a: CapabilityRule, b: CapabilityRule): boolean {
    return a.tier === b.tier && (a.maxLabel ?? 'internal') === (b.maxLabel ?? 'internal');
}

/**
 * N19 fast-track judgement. Single-signer revision is allowed only when all
 * five conditions hold; any failure falls back to dual sign-off.
 */
export function assessRevision(
    current: AgentGrant,
    next: TaskPolicyRequest,
    registry: AssetLabelRegistry,
): RevisionAssessment {
    const reasons: string[] = [];
    const wants = next.wants ?? {};

    for (const [key, nextRule] of Object.entries(wants)) {
        if (!nextRule) continue;
        const currentRule = current[key];
        if (!currentRule) {
            reasons.push(`${key}: 新增能力`);
            continue;
        }
        if (!ruleUnchanged(currentRule, nextRule)) {
            reasons.push(`${key}: tier/maxLabel 变更`);
        }
        if (!amountsEqual(currentRule.amountLimit, nextRule.amountLimit)) {
            reasons.push(`${key}: amountLimit 变更`);
        }
        const newPaths = (nextRule.paths ?? []).filter(
            (p) => !(currentRule.paths ?? []).includes(p),
        );
        if (pathsIntersectBoundary(newPaths, registry)) {
            reasons.push(`${key}: 新增路径命中边界集`);
        }
        if (pathsIntersectSecret(newPaths, registry)) {
            reasons.push(`${key}: 新增路径命中 secret 标注`);
        }
        const newHosts = (nextRule.hosts ?? []).filter(
            (h) => !(currentRule.hosts ?? []).includes(h),
        );
        if (newHosts.length > 0 && currentRule.hosts !== undefined) {
            // Host widening is a risk surface of its own; conservatively dual.
            reasons.push(`${key}: 新增 hosts`);
        }
    }

    const fastTrack = reasons.length === 0;
    return { dualApproval: !fastTrack, fastTrack, reasons };
}

export function makeRevision(
    request: TaskPolicyRequest,
    justification: string,
    requestedBy: string,
    registry: AssetLabelRegistry,
    current: AgentGrant,
    id: string,
): ContractRevision {
    const assessment = assessRevision(current, request, registry);
    return {
        id,
        requires: request.requires,
        wants: request.wants,
        justification,
        requestedBy,
        dualApproval: assessment.dualApproval,
        fastTrack: assessment.fastTrack,
    };
}
