/**
 * ApprovalSeam contract — human-in-the-loop confirmation for out-of-scope or
 * high-risk invocations.
 *
 * The approval seam is the L1 policy implementation consumed by the gateway's
 * approval stage. It is a peripheral service, never an in-process grant: an
 * approval authorizes one action or a bounded class of actions, and never
 * rewrites the root grant — persistent permission changes go exclusively
 * through ContractRevision.
 */

import type { EffectClass, EffectRule } from './authorization.js';

/**
 * Approval granularity.
 * once      — authorizes this single action, then expires;
 * session   — authorizes the whole effectClass for the current task
 *             execution, then expires with it;
 * workspace — authorizes the whole effectClass for the current workspace
 *             until revoked or the workspace is deleted.
 *
 * No granularity rewrites the root grant. once/session entries live on the
 * ToolGateway instance and are discarded when the task execution ends;
 * workspace entries are held by the workspace-level container (they outlive
 * tasks) and are visible to the gateway as a read-only view.
 */
export type ApprovalScope = 'once' | 'session' | 'workspace';

export interface ApprovalRequest {
    contractId: string;
    effectClass: EffectClass;
    current: EffectRule | undefined;
    requested: EffectRule;
    justification: string;
    payload: unknown;
}

export type ApprovalResult =
    | { kind: 'allowed'; scope: 'once' }
    | { kind: 'allowed'; scope: 'session' }
    | { kind: 'allowed'; scope: 'workspace' }
    | { kind: 'rejected'; reason: string }
    | { kind: 'cancelled' }
    | { kind: 'unavailable'; reason: string }; // fail-closed (V13)

export interface ApprovalSeam {
    request(req: ApprovalRequest): Promise<ApprovalResult>;
}
