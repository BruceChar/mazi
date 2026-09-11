/**
 * Authorization-inflation telemetry (§9.4 T7): the width of the effective
 * grant surface is an observable signal, so abnormally wide grants can be
 * flagged for root review. Pure measurement — no enforcement.
 */

import {
    type AgentGrant,
    type CapabilityRule,
    LABEL_RANK,
    type SensitivityLabel,
} from './types.js';

export interface AuthorizationWidth {
    capabilities: number;
    pathPatterns: number;
    hostPatterns: number;
    maxLabelDistribution: Record<SensitivityLabel, number>;
}

function isRule(value: unknown): value is CapabilityRule {
    return Boolean(value) && typeof value === 'object' && 'action' in (value as object);
}

export function authorizationWidth(grant: AgentGrant): AuthorizationWidth {
    const distribution: Record<SensitivityLabel, number> = {
        public: 0,
        internal: 0,
        sensitive: 0,
        secret: 0,
    };
    let capabilities = 0;
    let pathPatterns = 0;
    let hostPatterns = 0;
    for (const value of Object.values(grant)) {
        if (!isRule(value)) continue;
        capabilities += 1;
        pathPatterns += value.paths?.length ?? 0;
        hostPatterns += value.hosts?.length ?? 0;
        distribution[value.maxLabel ?? 'internal'] += 1;
    }
    void LABEL_RANK;
    return { capabilities, pathPatterns, hostPatterns, maxLabelDistribution: distribution };
}
