import { describe, expect, it } from 'vitest';
import type { GoalTreeSnapshot, UserBehaviorView } from '@mazi/libs';
import { collectBehaviors, summarizeBehaviors } from '../src/scripts/user-profile.ts';

const behavior = (
    ts: number,
    type: UserBehaviorView['type'],
    data: Record<string, unknown>,
): UserBehaviorView => ({ ts, type, data });

function snapshot(behaviors: UserBehaviorView[]): GoalTreeSnapshot {
    return { rootGoalId: 'r', goals: [], taskCount: 0, stepCount: 0, behaviors };
}

describe('user-profile（行为流 → 机械特征）', () => {
    it('collectBehaviors：跨 run 合并、按 ts 去重升序', () => {
        const merged = collectBehaviors([
            snapshot([behavior(30, 'feedback', { kind: 'text', text: 'b' }), behavior(10, 'input', { text: 'q' })]),
            snapshot([behavior(30, 'feedback', { kind: 'text', text: 'dup' }), behavior(20, 'approval', {})]),
            null,
        ]);
        expect(merged.map((b) => b.ts)).toEqual([10, 20, 30]);
        expect(merged[2]?.data.text).toBe('b');
    });

    it('summarizeBehaviors：计数、评分均值、拒绝率、授权延迟', () => {
        const summary = summarizeBehaviors([
            behavior(1, 'input', { text: 'q1' }),
            behavior(2, 'input', { text: 'q2' }),
            behavior(3, 'feedback', { kind: 'rating', rating: 5 }),
            behavior(4, 'feedback', { kind: 'rating', rating: 3 }),
            behavior(5, 'feedback', { kind: 'text', text: '啰嗦' }),
            behavior(6, 'feedback', { kind: 'interrupt' }),
            behavior(7, 'approval', {}),
            behavior(8, 'authorization', { decision: 'granted', latencyMs: 1000 }),
            behavior(9, 'authorization', { decision: 'denied', latencyMs: 3000 }),
        ]);
        expect(summary).toMatchObject({
            questions: 2,
            feedback: 4,
            interrupts: 1,
            ratings: 2,
            ratingAverage: 4,
            approvals: 1,
            granted: 1,
            denied: 1,
            denyRate: 0.5,
            avgApprovalLatencyMs: 2000,
        });
    });

    it('无授权/无评分时给 null，不臆造', () => {
        const summary = summarizeBehaviors([behavior(1, 'input', { text: 'q' })]);
        expect(summary.ratingAverage).toBeNull();
        expect(summary.denyRate).toBeNull();
        expect(summary.avgApprovalLatencyMs).toBeNull();
    });
});
