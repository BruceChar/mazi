/**
 * V5 审批响应集合（§2 / M5）。
 *
 * 用户对弹窗的响应就是他影响系统的全部接口：批准（可带作用域）、拒绝（进红线）、
 * 键入确认（hazard 持久化）、事后纠正（学习负样本 + 连带回滚，交 M6）。
 * settle 只负责把响应落到记忆/红线；纠正闭环由 correction 模块消费。
 */

import type { BlockedStore } from './blocked-store.js';
import type { MemoryStore } from './memory-store.js';

export type V5ApprovalScope = 'once' | 'session' | 'project';

export type V5ApprovalDecision =
    | { decision: 'granted'; scope: V5ApprovalScope; typedConfirm?: boolean }
    | { decision: 'rejected'; reason?: string }
    | { decision: 'correction'; reason?: string };

export interface SettleContext {
    key: string;
    sessionId?: string;
    /** hazard 受限条目（不可逆 / envelope），禁止 project 作用域。 */
    hazardLimited: boolean;
    contentHash?: string;
    now: number;
}

export function settleApproval(
    decision: V5ApprovalDecision,
    ctx: SettleContext,
    store: MemoryStore,
    blocked: BlockedStore,
): void {
    if (decision.decision === 'granted') {
        // once 当次有效，不落任何记忆。
        if (decision.scope === 'once') return;
        store.remember({
            key: ctx.key,
            scope: decision.scope,
            sessionId: ctx.sessionId,
            contentHash: ctx.contentHash,
            createdAt: ctx.now,
            hazardLimited: ctx.hazardLimited,
        });
        return;
    }
    if (decision.decision === 'rejected') {
        blocked.add(ctx.key);
        return;
    }
    // correction：事后纠正，由 M6 纠正闭环消费（负样本 + 连带回滚）。
}
