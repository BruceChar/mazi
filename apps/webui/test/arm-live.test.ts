import { describe, expect, it } from 'vitest';
import type { EventItem } from '../src/types.ts';
import {
    applyArmEvent,
    armStreamText,
    initialArmLive,
    liveStepOf,
} from '../src/scripts/arm-live.ts';

function event(type: string, payload: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): EventItem {
    return {
        eventId: type + ':' + Math.random().toString(36).slice(2),
        type,
        rootGoalId: 'run-1',
        timestamp: 1000,
        payload,
        ...extra,
    } as EventItem;
}

describe('arm-live（单臂实时投影）', () => {
    it('step.started 追加并收尾上一活跃步；step.ended 按 stepId 原地更新', () => {
        let live = initialArmLive('running');
        live = applyArmEvent(live, event('step.started', { kind: 'deliberation', status: 'active', content: '思考中' }, { stepId: 's1', taskId: 't1' }));
        expect(live.steps).toHaveLength(1);
        expect(live.steps[0]).toMatchObject({ stepId: 's1', status: 'active', endedAt: null });

        live = applyArmEvent(live, event('step.started', { kind: 'invocation', status: 'active', content: 'fs.read {}', toolName: 'fs.read' }, { stepId: 's2', taskId: 't1' }));
        expect(live.steps).toHaveLength(2);
        expect(live.steps[0]?.status).toBe('succeeded');

        live = applyArmEvent(live, event('step.ended', { kind: 'invocation', status: 'succeeded', content: 'fs.read {}\n→ ok', toolName: 'fs.read' }, { stepId: 's2', taskId: 't1' }));
        expect(live.steps.filter((step) => step.stepId === 's2')).toHaveLength(1);
        expect(live.steps[1]).toMatchObject({ status: 'succeeded', toolName: 'fs.read' });
        expect(live.steps[1]?.endedAt).toBe(1000);
    });

    it('llm.stream_event 累加流式正文；deliberation 落库后清空该 task 的流', () => {
        let live = initialArmLive('running');
        const delta = (text: string) =>
            event('llm.stream_event', { streamId: 'st1', attempt: 1, event: { type: 'text_delta', text } }, { taskId: 't1' });
        live = applyArmEvent(live, delta('你'), 1);
        live = applyArmEvent(live, delta('好'), 2);
        expect(armStreamText(live)).toBe('你好');

        live = applyArmEvent(live, event('step.ended', { kind: 'deliberation', status: 'succeeded', content: '你好', answer: '你好' }, { stepId: 's1', taskId: 't1' }));
        expect(armStreamText(live)).toBe('');
    });

    it('approval.requested 入列、granted/cancelled 出列；无 invocationId 忽略', () => {
        let live = initialArmLive('running');
        live = applyArmEvent(live, event('approval.requested', { invocationId: 'inv1', toolName: 'shell.run', summary: '需要写权限' }));
        expect(live.approvals).toEqual([
            { invocationId: 'inv1', toolName: 'shell.run', summary: '需要写权限', requestedAt: 1000 },
        ]);
        expect(applyArmEvent(live, event('approval.requested', { invocationId: 'inv1' })).approvals).toHaveLength(1);
        expect(applyArmEvent(live, event('approval.requested', {})).approvals).toHaveLength(1);
        live = applyArmEvent(live, event('approval.granted', { invocationId: 'inv1' }));
        expect(live.approvals).toEqual([]);
    });

    it('goal.ended → completed/failed；run.aborted → aborted；llm.error 记错误', () => {
        const running = initialArmLive('running');
        expect(applyArmEvent(running, event('goal.ended', { outcome: { status: 'success' } })).status).toBe('completed');
        expect(applyArmEvent(running, event('goal.ended', { outcome: { status: 'failed' } })).status).toBe('failed');
        expect(applyArmEvent(running, event('run.aborted', {})).status).toBe('aborted');
        expect(applyArmEvent(running, event('llm.error', { message: '限流' })).error).toBe('限流');
    });

    it('未知事件与同引用无变化', () => {
        const live = initialArmLive('running');
        expect(applyArmEvent(live, event('provider.selected', {}))).toBe(live);
        expect(liveStepOf(event('step.ended', { content: 'x' }, { stepId: 's9' }), 'succeeded')).toMatchObject({ stepId: 's9', title: 'x' });
    });
});
