/**
 * V12 escalation partial order (§12).
 *
 * Only a request that is *strictly wider* than the effective rule enters
 * justification validation and the approval chain. Equal / narrower /
 * incomparable requests MUST be ignored entirely by callers and treated as a
 * normal invocation — this is the structural fix for escalation loops.
 */

import { TIER_RANK } from './rules.js';
import { type CapabilityRule, LABEL_RANK, type Trigger } from './types.js';

const TRIGGER_CONSERVATISM: Readonly<Record<Trigger, number>> = {
    predeclare: 0,
    'on-failure': 1,
    'on-request': 2,
};

function broaderSet(
    requested: readonly string[] | undefined,
    effective: readonly string[] | undefined,
): boolean {
    if (effective === undefined) return false;
    if (requested === undefined) return true;
    return requested.some((value) => !effective.includes(value));
}

/**
 * Strictly wider iff tier is higher, or the same tier with a strictly broader
 * scope (broader paths/hosts, a larger amountLimit, a higher maxLabel or a
 * less conservative trigger).
 */
export function isStrictlyWider(requested: CapabilityRule, effective: CapabilityRule): boolean {
    if (!effective) return true;
    if (TIER_RANK[requested.tier] > TIER_RANK[effective.tier]) return true;
    if (TIER_RANK[requested.tier] < TIER_RANK[effective.tier]) return false;

    if (broaderSet(requested.paths, effective.paths)) return true;
    if (broaderSet(requested.hosts, effective.hosts)) return true;
    if ((requested.amountLimit?.amount ?? 0) > (effective.amountLimit?.amount ?? 0)) {
        return true;
    }
    const requestedLabel = requested.maxLabel ?? 'internal';
    const effectiveLabel = effective.maxLabel ?? 'internal';
    if (LABEL_RANK[requestedLabel] > LABEL_RANK[effectiveLabel]) return true;
    if (
        requested.trigger &&
        TRIGGER_CONSERVATISM[requested.trigger] <
            TRIGGER_CONSERVATISM[effective.trigger ?? 'on-failure']
    ) {
        return true;
    }
    return false;
}
