import type { EffectClass, EffectRule } from './authorization';

export interface ApprovalRequest {
    contractId: string;
    effectClass: EffectClass;
    current: EffectRule | undefined;
    requested: EffectRule;
    justification: string;
    payload: unknown;
}

export type ApprovalResult =
    | { kind: 'allowed-once' }
    | { kind: 'rejected'; reason: string }
    | { kind: 'cancelled' }
    | { kind: 'unavailable'; reason: string }; // fail-closed（V13）

export interface ApprovalSeam {
    request(req: ApprovalRequest): Promise<ApprovalResult>;
}
