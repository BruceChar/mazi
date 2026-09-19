import { describe, expect, it } from 'vitest';
import type { QuestionLabelView } from '../src/question-taxonomy.js';
import { buildQuestionView, effectiveLabels } from '../src/question-taxonomy.js';

const label = (
    axis: QuestionLabelView['axis'],
    value: string,
    source: QuestionLabelView['source'] = 'llm',
): QuestionLabelView => ({ axis, label: value, source });

describe('question-taxonomy（有效标签合并）', () => {
    it('单标签轴：user > llm > rule 取一条', () => {
        const effective = effectiveLabels([
            label('speech_act', 'task', 'rule'),
            label('speech_act', 'question', 'llm'),
            label('speech_act', 'feedback', 'user'),
        ]);
        expect(effective.speech_act).toEqual(['feedback']);
    });

    it('多标签轴：rule ∪ llm 去重；存在 user 行时整轴以 user 为准', () => {
        expect(
            effectiveLabels([label('category', 'health', 'rule'), label('category', 'health', 'llm'), label('category', 'finance', 'llm')]).category,
        ).toEqual(['finance', 'health']);
        expect(
            effectiveLabels([label('category', 'health', 'llm'), label('category', 'growth', 'user')]).category,
        ).toEqual(['growth']);
    });

    it('buildQuestionView：附带原始标签与有效标签', () => {
        const view = buildQuestionView(
            {
                questionId: 'q1',
                ts: 1,
                text: '我该怎么规划职业？',
                derived: false,
                sessionId: 's1',
                createdAt: 1,
            },
            [label('domain', 'growth'), label('topic', 'career', 'llm')],
        );
        expect(view.effective.domain).toEqual(['growth']);
        expect(view.effective.topic).toEqual(['career']);
        expect(view.labels).toHaveLength(2);
    });
});
