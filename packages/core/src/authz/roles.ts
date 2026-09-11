/**
 * Role annotations and reversibility credentials (§4.3).
 *
 * A role is declared at tool registration. `commit: reversible` is the
 * conjunction of a declaration and a credential the backend can actually
 * execute (V15): a missing or unsupported credential degrades the role to
 * `recoverable`, so R6 does not apply.
 */

import { contentVersion } from './hash.js';
import type { BackendCapabilities, CapabilityKey, ReversibilityEvidence, Role } from './types.js';

export const DOMAIN_TEARDOWN: ReversibilityEvidence = 'domain-teardown';
export const TASK_SCRATCH: ReversibilityEvidence = 'task-scratch';

/** Most conservative role — used by R4 for opaque tools (three questions unanswerable). */
export const WORST_ROLE: Role = {
    transfer: 'egress',
    commit: 'committed',
    opacity: 'opaque',
};

export interface EffectiveRole extends Role {
    /** True when a reversible declaration lost its credential backing (V15). */
    credentialBypassed: boolean;
}

/** Credential is actually executable by the backend (V15). */
export function isCredentialSupported(role: Role, backend: BackendCapabilities): boolean {
    if (role.commit !== 'reversible' || !role.reversibleBy) return false;
    return backend.supportsReversibility.includes(role.reversibleBy);
}

export function resolveEffectiveRole(role: Role, backend: BackendCapabilities): EffectiveRole {
    const credentialBypassed =
        role.commit === 'reversible' && !isCredentialSupported(role, backend);
    if (!credentialBypassed) return { ...role, credentialBypassed: false };
    return { ...role, commit: 'recoverable', credentialBypassed: true };
}

export function isReversible(role: Role): boolean {
    return role.commit === 'reversible';
}

export function isCommitted(role: Role): boolean {
    return role.commit === 'committed';
}

export function isEgress(role: Role): boolean {
    return role.transfer === 'egress';
}

export function isIngest(role: Role): boolean {
    return role.transfer === 'ingest';
}

export function isOpaque(role: Role): boolean {
    return role.opacity === 'opaque';
}

/** Role registry (TCB component): declaration version participates in pinning (T1). */
export class RoleRegistry {
    readonly roles: Readonly<Record<CapabilityKey, Role>>;
    readonly version: number;

    constructor(roles: Readonly<Record<CapabilityKey, Role>> = {}) {
        this.roles = Object.freeze({ ...roles });
        this.version = contentVersion(this.roles);
    }

    roleOf(capability: CapabilityKey): Role | undefined {
        return this.roles[capability];
    }

    withRoles(roles: Readonly<Record<CapabilityKey, Role>>): RoleRegistry {
        return new RoleRegistry({ ...this.roles, ...roles });
    }
}
