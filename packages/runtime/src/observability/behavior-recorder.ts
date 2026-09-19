/**
 * behavior-recorder —— 把运行时事实（用户输入 / 反馈 / 审批事件）物化为用户行为指令。
 *
 * 唯一写入口：用户行为流只在记录器侧追加；审批发起与授权由事件总线驱动，
 * 只记录用户来源（by='user'）的结算——超时/停机关闭不记授权（设计文档 §10.5）。
 */

import type { HarnessEvent } from '@mazi/core';
import type { UserBehaviorView } from '@mazi/libs';
import type { FeedbackInput } from '../harness/conversation.js';
import type { BehaviorRecordInput, BehaviorStore } from '../memory/behavior-store.js';

interface PendingApproval {
    requestedAt: number;
    approvalTs?: number;
}

function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function stringOf(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * 反馈载荷 → 行为记录：rating 与 text 各自单独成条（验收 UB-1）；
 * 两者都缺失时保留一条占位（kind 为 rating/text），不丢用户行为。
 */
export function feedbackBehaviorRecords(feedback: FeedbackInput): BehaviorRecordInput[] {
    const records: BehaviorRecordInput[] = [];
    if (feedback.rating !== undefined) {
        records.push({ type: 'feedback', data: { kind: 'rating', rating: feedback.rating } });
    }
    const text =
        feedback.content !== undefined && feedback.content.length > 0
            ? feedback.content
            : undefined;
    if (text !== undefined) {
        records.push({ type: 'feedback', data: { kind: 'text', text } });
    }
    if (records.length === 0) {
        records.push({
            type: 'feedback',
            data: { kind: feedback.type === 'output_rating' ? 'rating' : 'text' },
        });
    }
    return records;
}

/** 用户行为指令记录器：输入/反馈显式调用，审批事件经 handleApprovalEvent。 */
export class BehaviorRecorder {
    private readonly pending = new Map<string, PendingApproval>();
    private readonly store: BehaviorStore;
    private readonly now: () => number;

    constructor(store: BehaviorStore, now: () => number = () => Date.now()) {
        this.store = store;
        this.now = now;
    }

    recordInput(rootGoalId: string, text: string): Promise<UserBehaviorView[]> {
        return this.store.append(rootGoalId, [{ type: 'input', data: { text } }]);
    }

    recordFeedback(rootGoalId: string, feedback: FeedbackInput): Promise<UserBehaviorView[]> {
        return this.store.append(rootGoalId, feedbackBehaviorRecords(feedback));
    }

    /** 审批事件 → 行为流（approval 发起锚点 / authorization 用户授权）。 */
    async handleApprovalEvent(event: HarnessEvent): Promise<void> {
        if (event.type === 'approval.requested') {
            await this.onRequested(event);
        } else if (event.type === 'approval.granted' || event.type === 'approval.cancelled') {
            await this.onSettled(event);
        }
    }

    list(rootGoalId: string): Promise<UserBehaviorView[]> {
        return this.store.list(rootGoalId);
    }

    close(): void {
        this.store.close();
    }

    private async onRequested(event: HarnessEvent): Promise<void> {
        const payload = asRecord(event.payload);
        const invocationId = stringOf(payload.invocationId);
        if (invocationId === undefined) return;
        const requestedAt = numberOf(payload.requestedAt) ?? event.timestamp;
        // 先同步登记 pending，保证紧邻的结算事件也能取到 requestedAt（ref 补 approvalTs）。
        this.pending.set(invocationId, { requestedAt });
        const capability = stringOf(payload.capability);
        const summary = stringOf(payload.summary);
        const [written] = await this.store.append(event.rootGoalId, [
            {
                type: 'approval',
                ts: requestedAt,
                data: {
                    invocationId,
                    ...(capability !== undefined ? { capability } : {}),
                    ...(summary !== undefined ? { summary } : {}),
                    ...(Array.isArray(payload.allowedScopes)
                        ? { allowedScopes: payload.allowedScopes }
                        : {}),
                },
            },
        ]);
        const state = this.pending.get(invocationId);
        if (state !== undefined && written !== undefined) state.approvalTs = written.ts;
    }

    private async findApprovalTs(
        rootGoalId: string,
        invocationId: string,
    ): Promise<number | undefined> {
        const existing = await this.store.list(rootGoalId);
        return existing.find(
            (view) => view.type === 'approval' && view.data.invocationId === invocationId,
        )?.ts;
    }

    private async onSettled(event: HarnessEvent): Promise<void> {
        const payload = asRecord(event.payload);
        const invocationId = stringOf(payload.invocationId);
        if (invocationId === undefined) return;
        const state = this.pending.get(invocationId);
        this.pending.delete(invocationId);
        // 超时/停机关闭不是用户行为，不记 authorization。
        if (stringOf(payload.by) !== 'user') return;
        const decision =
            payload.decision === 'granted'
                ? 'granted'
                : payload.decision === 'rejected'
                  ? 'denied'
                  : undefined;
        if (decision === undefined) return;
        const latencyMs =
            numberOf(payload.latencyMs) ??
            Math.max(0, this.now() - (state?.requestedAt ?? event.timestamp));
        const scope = stringOf(payload.scope);
        // 审批被秒批时 approvalTs 可能尚未回填：从流内按 invocationId 兜底定位锚点。
        const approvalTs =
            state?.approvalTs ?? (await this.findApprovalTs(event.rootGoalId, invocationId));
        await this.store.append(event.rootGoalId, [
            {
                type: 'authorization',
                ...(approvalTs !== undefined ? { ref: { ts: approvalTs } } : {}),
                data: {
                    decision,
                    ...(scope !== undefined ? { scope } : {}),
                    latencyMs,
                },
            },
        ]);
    }
}
