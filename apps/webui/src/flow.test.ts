import { describe, expect, it } from 'vitest';
import { flattenConversationFlow, flattenSessionFlow } from './flow.ts';

function step(id, seq, kind, startedAt) {
    return { stepId: id, seq, kind, status: 'ok', startedAt };
}

function session(id, rawIntent, createdAt, turns) {
    return { sessionId: id, rawIntent, createdAt, turns };
}

describe('conversation chat flow flattening', () => {
    it('同一 Session 输出 user 行后按 Turn/Step 顺序展开', () => {
        const rows = flattenSessionFlow(
            session('s1', '你好', 10, [
                { turnId: 't1', steps: [step('s1-step1', 0, 'thinking', 11)] },
            ]),
        );
        expect(rows.map((r) => r.type)).toEqual(['user', 'step']);
        expect(rows[1]).toMatchObject({ key: 'step:s1:s1-step1', step: { kind: 'thinking' } });
    });

    it('Conversation 内多个 Session 按 createdAt 连续排序且不出现 Session 导航行', () => {
        const rows = flattenConversationFlow([
            session('s2', '追问', 30, [
                { turnId: 't2', steps: [step('s2-step1', 0, 'thinking', 31)] },
            ]),
            session('s1', '第一问', 10, [
                { turnId: 't1', steps: [step('s1-step1', 0, 'thinking', 11)] },
            ]),
        ]);
        expect(rows.map((r) => r.key)).toEqual([
            'user:s1',
            'step:s1:s1-step1',
            'user:s2',
            'step:s2:s2-step1',
        ]);
        expect(rows.every((r) => r.type === 'user' || r.type === 'step')).toBe(true);
    });

    it('已成功 Session 中最后一个成功 thinking 标记为 assistant 输出，其余内部步骤为 step', () => {
        const rows = flattenSessionFlow({
            sessionId: 's1',
            rawIntent: '读取文件',
            outcome: 'success',
            createdAt: 10,
            turns: [
                {
                    turnId: 't1',
                    steps: [
                        step('a', 0, 'thinking', 11),
                        step('b', 1, 'tool_call', 12),
                        step('c', 2, 'observation', 13),
                        step('d', 3, 'thinking', 14),
                    ],
                },
            ],
        });
        expect(rows.map((r) => `${r.type}:${r.key}`)).toEqual([
            'user:user:s1',
            'step:step:s1:a',
            'step:step:s1:b',
            'step:step:s1:c',
            'assistant:step:s1:d',
        ]);
    });
});
