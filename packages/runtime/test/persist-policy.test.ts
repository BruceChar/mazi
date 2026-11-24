import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '@mazi/core';
import { shouldPersist, slimForStore, CONTENT_CAP } from '../src/events/persist-policy.js';

function ev(over: Partial<HarnessEvent> & Pick<HarnessEvent, 'type' | 'rootGoalId'>): HarnessEvent {
    return { eventId: 'evt-' + Math.random().toString(36).slice(2), timestamp: Date.now(), attributes: {}, ...over } as HarnessEvent;
}

describe('shouldPersist 持久化过滤', () => {
    it('llm.stream_event 不落盘（逐 token 流式碎片，实际内容由 step.ended 承载）', () => {
        expect(shouldPersist(ev({ type: 'llm.stream_event', rootGoalId: 'rg' }))).toBe(false);
    });

    it('权限/目标/步骤等其余事件照常落盘', () => {
        for (const type of ['policy.check', 'policy.denied', 'approval.granted', 'approval.requested', 'goal.started', 'step.ended', 'tool.invoke']) {
            expect(shouldPersist(ev({ type, rootGoalId: 'rg' }))).toBe(true);
        }
    });
});

describe('slimForStore step 落盘裁剪（复用 step.ended 保实际内容）', () => {
    it('step.started 只存元数据：丢弃 content/thinking/answer/output/result', () => {
        const slim = slimForStore(
            ev({
                type: 'step.started',
                rootGoalId: 'rg',
                goalId: 'g',
                stepId: 's',
                payload: { kind: 'tool', status: 'running', goalId: 'g', taskId: 't', content: 'A'.repeat(9000), output: 'B'.repeat(3000), toolName: 'shell', usage: { inputTokens: 3 } },
            }),
        ) as HarnessEvent & { payload: Record<string, unknown> };
        expect(slim.payload.content).toBeUndefined();
        expect(slim.payload.output).toBeUndefined();
        expect(slim.payload.toolName).toBe('shell');
        expect(slim.payload.kind).toBe('tool');
        expect(slim.payload.status).toBe('running');
        expect(slim.payload.usage).toEqual({ inputTokens: 3 });
    });

    it('step.ended 保留实际内容与元数据，超长文本截断到 CONTENT_CAP', () => {
        const long = 'C'.repeat(CONTENT_CAP + 2000);
        const slim = slimForStore(
            ev({
                type: 'step.ended',
                rootGoalId: 'rg',
                goalId: 'g',
                taskId: 't',
                stepId: 's',
                payload: { kind: 'deliberation', status: 'ok', goalId: 'g', taskId: 't', answer: long, content: 'short', usage: { inputTokens: 10, outputTokens: 5 } },
            }),
        ) as HarnessEvent & { payload: Record<string, unknown> };
        const answer = slim.payload.answer as string;
        expect(answer.length).toBeLessThanOrEqual(CONTENT_CAP + 40);
        expect(answer).toContain('截断');
        expect(slim.payload.content).toBe('short');
        expect(slim.payload.kind).toBe('deliberation');
        expect(slim.payload.status).toBe('ok');
        expect(slim.payload.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
        expect(slim.stepId).toBe('s');
    });

    it('不修改原事件（落盘副本裁剪，内存事件保持完整）', () => {
        const long = 'D'.repeat(CONTENT_CAP + 100);
        const original = ev({ type: 'step.ended', rootGoalId: 'rg', payload: { answer: long } });
        slimForStore(original);
        expect((original.payload as Record<string, unknown>).answer).toBe(long);
    });

    it('非 step 事件原样返回', () => {
        const original = ev({ type: 'policy.check', rootGoalId: 'rg', payload: { decision: 'allow' } });
        expect(slimForStore(original)).toEqual(original);
    });
});
