/**
 * Enforcement-layer component seams (V3 §7 floor 2, §8).
 *
 * The sandbox backend and the egress proxy are TCB-enforced axes. When a
 * declared axis is unavailable the operation is rejected rather than proceeding
 * (fail-closed); a deployment may explicitly choose a disclosed degradation.
 */

import type { AuthzErrorCode } from './types.js';

export interface SandboxBackend {
    readonly id: string;
    available(): boolean;
}

export interface EgressProxy {
    readonly id: string;
    available(): boolean;
}

function unavailable(code: AuthzErrorCode, component: string): Error {
    const error = new Error(`${component} 不可用：拒绝执行（缺件即拒绝）`);
    (error as Error & { code: AuthzErrorCode }).code = code;
    return error;
}

/** Throws SANDBOX_UNAVAILABLE when a declared sandbox axis is absent. */
export function requireSandbox(backend: SandboxBackend | undefined): SandboxBackend {
    if (!backend || !backend.available()) throw unavailable('SANDBOX_UNAVAILABLE', '沙盒后端');
    return backend;
}

/** Throws EGRESS_BLOCKED when egress requires a proxy that is absent. */
export function requireEgressProxy(proxy: EgressProxy | undefined): EgressProxy {
    if (!proxy || !proxy.available()) throw unavailable('EGRESS_BLOCKED', '出网代理');
    return proxy;
}
