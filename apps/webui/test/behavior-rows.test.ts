import { describe, expect, it } from 'vitest';
import type { UserBehaviorView } from '@mazi/libs';
import { behaviorRowsOf, groupBehaviorsByTask } from '../src/scripts/behavior-rows.ts';

const behavior = (ts: number, type: UserBehaviorView['type'], data: Record<string, unknown>): UserBehaviorView => ({
    ts,
    type,
    data,
});

describe('behavior-rows（用户行为指令 → 执行流行）', () => {
    it('过滤 input/setting，按 at 顺序渲染 approval/authorization/feedback', () => {
        const rows = behaviorRowsOf(
            [],
            [
                behavior(30, 'authorization', { decision: 'granted', scope: 'once', latencyMs: 1200 }),
                behavior(10, 'approval', { summary: 'shell.run: rm -rf build' }),
                behavior(5, 'input', { text: 'hi' }),
                behavior(20, 'feedback', { kind: 'rating', rating: 2 }),
                behavior(40, 'setting', { key: 'model', value: 'x' }),
            ],
        );
        expect(rows.map((row) => row.type)).toEqual(['approval', 'feedback', 'authorization']);
        expect(rows[0]).toMatchObject({ label: '审批', summary: 'shell.run: rm -rf build', icon: 'info' });
        expect(rows[1]).toMatchObject({ label: '反馈', summary: '评分 2', icon: 'dislike' });
        expect(rows[2]).toMatchObject({
            label: '授权',
            summary: '允许 · once · 1200ms',
            icon: 'shield',
        });
    });

    it('文本反馈取正文；拒绝授权摘要', () => {
        const rows = behaviorRowsOf(
            [],
            [
                behavior(1, 'feedback', { kind: 'text', text: '太啰嗦' }),
                behavior(2, 'authorization', { decision: 'denied', latencyMs: 800 }),
            ],
        );
        expect(rows[0]?.summary).toBe('太啰嗦');
        expect(rows[0]?.icon).toBe('userMessage');
        expect(rows[1]?.summary).toBe('拒绝 · 800ms');
    });

    it('groupBehaviorsByTask：按时窗分组，反馈落末组', () => {
        const rows = behaviorRowsOf(
            [],
            [
                behavior(10, 'approval', {}),
                behavior(30, 'feedback', { kind: 'rating', rating: 5 }),
                behavior(50, 'feedback', { kind: 'text', text: 'ok' }),
            ],
        );
        const groups = groupBehaviorsByTask([0, 25], rows);
        expect(groups[0]?.map((r) => r.at)).toEqual([10]);
        expect(groups[1]?.map((r) => r.at)).toEqual([30, 50]);
    });
});
