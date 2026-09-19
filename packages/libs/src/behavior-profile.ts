/**
 * behavior-profile —— 用户行为流的聚合与机械特征（纯函数，api/webui 共享）。
 *
 * 画像当前只提供 mechanical features（用户行为流设计文档 §5.2）：计数、评分均值、
 * 授权拒绝率与延迟。LLM 维度分析（§5.1）待独立分析器，不在此臆造（宁缺毋滥）。
 */

import type { UserBehaviorView } from './behavior.js';
import type { GoalTreeSnapshot } from './types.js';

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

/** 按 ts 合并两组行为指令（跨会话聚合的输入）。 */
export function mergeBehaviors(
    ...groups: ReadonlyArray<readonly UserBehaviorView[]>
): UserBehaviorView[] {
    const byTs = new Map<number, UserBehaviorView>();
    for (const group of groups) {
        for (const behavior of group) {
            if (!byTs.has(behavior.ts)) byTs.set(behavior.ts, behavior);
        }
    }
    return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

export interface BehaviorProfileSummary {
    /** 样本量（行为指令条数）。 */
    total: number;
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
    /** 证据量是否达到出结论阈值（默认 8 条，设计文档 §5.1）。 */
    sufficient: boolean;
}

export const PROFILE_MIN_EVIDENCE = 8;

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
        total: behaviors.length,
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
        sufficient: behaviors.length >= PROFILE_MIN_EVIDENCE,
    };
}
