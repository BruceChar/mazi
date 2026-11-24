import { describe, expect, it } from 'vitest';
import type { ExperimentView } from '@mazi/core';
import { CONTEXT_ANSWER_LIMIT_CHARS, contextHistoryOf } from '../src/experiment/context.js';

function view(partial: Partial<ExperimentView> = {}): ExperimentView {
    return {
        experimentId: 'exp-1',
        title: '第一轮',
        input: '列出三个方案',
        baseline: {},
        variables: [],
        arms: [
            {
                label: 'A',
                spec: { label: 'A' },
                status: 'completed',
                metrics: { finalAnswer: 'A 结论' } as never,
            },
            {
                label: 'B',
                spec: { label: 'B' },
                status: 'failed',
                metrics: { finalAnswer: '' } as never,
            },
        ],
        status: 'completed',
        createdAt: 0,
        reviews: [],
        ...partial,
    };
}

describe('contextHistoryOf（关联实验 → 两臂共用历史）', () => {
    it('指定臂：输入作 user 轮、最终答案作 assistant 轮', () => {
        expect(contextHistoryOf(view(), 'A')).toEqual([
            { role: 'user', text: '列出三个方案' },
            { role: 'assistant', text: 'A 结论' },
        ]);
    });

    it('缺省臂：取第一个有最终答案的臂（A 臂无答案时落到 B 臂）', () => {
        const empty = view();
        empty.arms[0]!.metrics = undefined;
        empty.arms[1]!.metrics = { finalAnswer: 'B 结论' } as never;
        expect(contextHistoryOf(empty)?.at(-1)).toEqual({ role: 'assistant', text: 'B 结论' });
    });

    it('关联臂没有最终答案 → undefined（宁可干净，也不拿空答案冒充历史）', () => {
        expect(contextHistoryOf(view(), 'B')).toBeUndefined();
    });

    it('超长答案截断到上限并留标记', () => {
        const long = view();
        long.arms[0]!.metrics = { finalAnswer: 'x'.repeat(CONTEXT_ANSWER_LIMIT_CHARS + 1) } as never;
        const history = contextHistoryOf(long, 'A');
        expect(history?.[1]?.text.length).toBe(CONTEXT_ANSWER_LIMIT_CHARS + '…（历史答案已截断）'.length);
        expect(history?.[1]?.text.endsWith('…（历史答案已截断）')).toBe(true);
    });

    it('输入为空时只保留 assistant 轮', () => {
        expect(contextHistoryOf(view({ input: '   ' }), 'A')).toEqual([
            { role: 'assistant', text: 'A 结论' },
        ]);
    });
});
