/**
 * user-profile —— 用户行为流的本地聚合（纯函数，供个人中心画像/行为链视图与单测）。
 *
 * 画像当前只提供 mechanical features（设计文档 §5.2）：计数、评分均值、授权拒绝率与延迟。
 * LLM 维度分析（§5.1）待独立分析器，不在此臆造（宁缺毋滥）。
 */

import type { GoalTreeSnapshot, UserBehaviorView } from '@mazi/libs';

/** 合并多个 run 快照的行为指令：按 ts 去重、升序（ts 即 id）。 */
export function collectBehaviors(
    snapshots: readonly (GoalTreeSnapshot | null | undefined)[],
): UserBehaviorView[] {
    const byTs = new Map<number, UserBehaviorView>();
    for (const snapshot of snapshots) {
        for (const behavior of snapshot?.behaviors ?? []) {
            if (!byTs.has(behavior.ts)) byTs.set(behavior.ts, behavior);
        }
    }
    return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

export interface BehaviorProfileSummary {
    questions: number;
    feedback: number;
    interrupts: number;
    /** 评分次数（kind='rating'）。 */
    ratings: number;
    ratingAverage: number | null;
    approvals: number;
    granted: number;
    denied: number;
    /** denied / (granted + denied)；无授权时为 null（宁缺毋滥）。 */
    denyRate: number | null;
    avgApprovalLatencyMs: number | null;
}

export function summarizeBehaviors(behaviors: readonly UserBehaviorView[]): BehaviorProfileSummary {
    const ratings: number[] = [];
    const latencies: number[] = [];
    let questions = 0;
    let feedback = 0;
    let interrupts = 0;
    let approvals = 0;
    let granted = 0;
    let denied = 0;
    for (const behavior of behaviors) {
        if (behavior.type === 'input') {
            questions += 1;
            continue;
        }
        if (behavior.type === 'approval') {
            approvals += 1;
            continue;
        }
        if (behavior.type === 'authorization') {
            if (behavior.data.decision === 'granted') granted += 1;
            else if (behavior.data.decision === 'denied') denied += 1;
            if (typeof behavior.data.latencyMs === 'number')
                latencies.push(behavior.data.latencyMs);
            continue;
        }
        if (behavior.type === 'feedback') {
            feedback += 1;
            if (behavior.data.kind === 'rating' && typeof behavior.data.rating === 'number') {
                ratings.push(behavior.data.rating);
            }
            if (behavior.data.kind === 'interrupt') interrupts += 1;
        }
    }
    const decided = granted + denied;
    return {
        questions,
        feedback,
        interrupts,
        ratings: ratings.length,
        ratingAverage:
            ratings.length > 0 ? ratings.reduce((sum, n) => sum + n, 0) / ratings.length : null,
        approvals,
        granted,
        denied,
        denyRate: decided > 0 ? denied / decided : null,
        avgApprovalLatencyMs:
            latencies.length > 0
                ? latencies.reduce((sum, n) => sum + n, 0) / latencies.length
                : null,
    };
}
