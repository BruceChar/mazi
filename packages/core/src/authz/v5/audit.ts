/**
 * V5 决策记录（§10/D19）。
 *
 * 决策记录与 auto 留痕视图分离：决策记录是完整审计（三问、hazard 命中项、
 * 指纹/模式依据、attested、通道、原因码、结果、作用域），仅 auth 内核追加；
 * 留痕视图只面向用户展示 auto 项。审计链哈希签名沿用 trust.ts。
 */

import type { Attestation, Channel, Decision } from './decision.js';
import type { MemoryScope } from './memory-store.js';

export type DecisionReason =
    | 'bottom-secret'
    | 'bottom-destroy'
    | 'bottom-taint-egress'
    | 'bottom-meta'
    | 'blocked-redline'
    | 'hazard'
    | 'passthrough'
    | 'memory'
    | 'routine'
    | 'read-log'
    | 'default-ask';

export interface DecisionRecord {
    id: string;
    at: number;
    decision: Decision;
    reason: DecisionReason;
    target: string;
    channel: Channel;
    attested: Attestation;
    /** 命中的 hazard 谓词项。 */
    hazardHits?: string[];
    basis?: 'passthrough' | 'memory' | 'routine' | 'read-log';
    binding?: string;
    scope?: MemoryScope;
    detail?: string;
}
