import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '@mazi/core';
import { shouldPersist, slimForStore } from '../src/events/persist-policy.js';

function ev(over: Partial<HarnessEvent> & Pick<HarnessEvent, 'type' | 'rootGoalId'>): HarnessEvent {
    return { eventId: 'evt-' + Math.random().toString(36).slice(2), timestamp: Date.now(), attributes: {}, ...over } as HarnessEvent;
}

describe('shouldPersist 持久化过滤', () => {
    it('llm.stream_event 不落盘（实时流式碎片，审计不需要）', () => {
        expect(shouldPersist(ev({ type: 'llm.stream_event', rootGoalId: 'rg' }))).toBe(false);
    });

    it('权限/目标/步骤等其余事件照常落盘', () => {
        for (const type of ['policy.check', 'policy.denied', 'approval.granted', 'approval.requested', 'goal.started', 'step.ended', 'tool.invoke']) {
            expect(shouldPersist(ev({ type, rootGoalId: 'rg' }))).toBe(true);
        }
    });
});

describe('slimForStore step 事件裁剪', () => {
    function stepEnded(): HarnessEvent {
        return ev({
            type: 'step.ended',
            rootGoalId: 'rg',
            goalId: 'g',
            taskId: 't',
            stepId: 's',
            payload: {
                kind: 'deliberation',
                status: 'ok',
                goalId: 'g',
                taskId: 't',
                content: 'X'.repeat(12_000),
                thinking: 'Y'.repeat(4_000),
                answer: 'Z'.repeat(4_000),
                usage: { inputTokens: 10, outputTokens: 5 },
            },
        });
    }

    it('剥离大文本 content/thinking/answer，保留结构化元数据与 usage', () => {
        const slim = slimForStore(stepEnded()) as HarnessEvent & { payload: Record<string, unknown> };
        expect(slim.payload.content).toBeUndefined();
        expect(slim.payload.thinking).toBeUndefined();
        expect(slim.payload.answer).toBeUndefined();
        expect(slim.payload.kind).toBe('deliberation');
        expect(slim.payload.status).toBe('ok');
        expect(slim.payload.goalId).toBe('g');
        expect(slim.payload.taskId).toBe('t');
        expect(slim.payload.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
        expect(slim.goalId).toBe('g');
        expect(slim.stepId).toBe('s');
    });

    it('不修改原事件（落盘副本裁剪，内存事件保持完整）', () => {
        const original = stepEnded();
        slimForStore(original);
        const payload = original.payload as Record<string, unknown>;
        expect(payload.content).toBe('X'.repeat(12_000));
        expect(payload.thinking).toBe('Y'.repeat(4_000));
    });

    it('step.started 同样裁剪', () => {
        const slim = slimForStore(
            ev({ type: 'step.started', rootGoalId: 'rg', payload: { kind: 'tool', status: 'running', content: 'A'.repeat(9_000), output: 'B'.repeat(3_000), toolName: 'shell' } }),
        ) as HarnessEvent & { payload: Record<string, unknown> };
        expect(slim.payload.content).toBeUndefined();
        expect(slim.payload.output).toBeUndefined();
        expect(slim.payload.toolName).toBe('shell');
    });

    it('非 step 事件原样返回', () => {
        const original = ev({ type: 'policy.check', rootGoalId: 'rg', payload: { decision: 'allow' } });
        expect(slimForStore(original)).toEqual(original);
    });
});
