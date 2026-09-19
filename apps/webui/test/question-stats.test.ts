import { describe, expect, it } from 'vitest';
import type { UserQuestionView } from '@mazi/libs';
import { effectiveDistribution } from '../src/scripts/question-stats.ts';

function question(effective: UserQuestionView['effective']): UserQuestionView {
    return {
        questionId: 'q',
        ts: 1,
        text: 'x',
        derived: false,
        sessionId: 's',
        createdAt: 1,
        labels: [],
        effective,
    };
}

describe('question-stats（标签分布）', () => {
    it('按轴统计，count 降序、label 升序', () => {
        const rows = effectiveDistribution(
            [
                question({ domain: ['professional'], topic: ['code'] }),
                question({ domain: ['professional', 'growth'] }),
                question({ domain: ['growth'] }),
            ],
            'domain',
        );
        expect(rows).toEqual([
            { label: 'growth', count: 2 },
            { label: 'professional', count: 2 },
        ]);
    });

    it('空输入 → 空分布', () => {
        expect(effectiveDistribution([], 'domain')).toEqual([]);
    });
});
