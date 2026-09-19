import { describe, expect, it } from 'vitest';
import type { StepView } from '../src/types.js';
import type { UserBehaviorView } from '../src/behavior.js';
import { projectBehaviorTimeline } from '../src/behavior.js';

function step(over: Partial<StepView> & Pick<StepView, 'startedAt'>): StepView {
    return {
        stepId: over.stepId ?? 's',
        goalId: 'g',
        taskId: 't',
        kind: 'deliberation',
        status: 'succeeded',
        ...over,
    };
}

function behavior(ts: number, type: UserBehaviorView['type'] = 'feedback'): UserBehaviorView {
    return { ts, type, data: {} };
}

describe('projectBehaviorTimeline（用户行为指令 → Step 时间线只读投影）', () => {
    it('空输入 → 空时间线', () => {
        expect(projectBehaviorTimeline([], [])).toEqual([]);
    });

    it('按 at 合并排序：用户问题在首个 Step 之前', () => {
        const timeline = projectBehaviorTimeline(
            [step({ stepId: 'd1', startedAt: 100 })],
            [behavior(10, 'input')],
        );
        expect(timeline.map((entry) => entry.source)).toEqual(['behavior', 'step']);
        expect(timeline[0]).toMatchObject({ at: 10, behavior: { type: 'input' } });
    });

    it('同 at：行为在前、Step 在后', () => {
        const timeline = projectBehaviorTimeline(
            [step({ stepId: 'd1', startedAt: 50 })],
            [behavior(50, 'feedback')],
        );
        expect(timeline.map((entry) => entry.source)).toEqual(['behavior', 'step']);
    });

    it('同源同 at 按 id 稳定排序（Step 之间）', () => {
        const timeline = projectBehaviorTimeline(
            [
                step({ stepId: 'b', startedAt: 7 }),
                step({ stepId: 'a', startedAt: 7 }),
                step({ stepId: 'c', startedAt: 7 }),
            ],
            [],
        );
        expect(timeline.map((entry) => (entry.source === 'step' ? entry.step.stepId : '?'))).toEqual([
            'a',
            'b',
            'c',
        ]);
    });

    it('审批发起与授权按 ts 前后配对；反馈插入其间', () => {
        const timeline = projectBehaviorTimeline(
            [],
            [behavior(30, 'authorization'), behavior(10, 'approval'), behavior(20, 'feedback')],
        );
        expect(
            timeline.map((entry) => (entry.source === 'behavior' ? entry.behavior.type : '?')),
        ).toEqual(['approval', 'feedback', 'authorization']);
    });

    it('确定性：同输入同输出，且不修改输入数组', () => {
        const steps = [step({ stepId: 'b', startedAt: 2 }), step({ stepId: 'a', startedAt: 1 })];
        const behaviors = [behavior(3), behavior(1)];
        const stepsBefore = structuredClone(steps);
        const behaviorsBefore = structuredClone(behaviors);

        const first = projectBehaviorTimeline(steps, behaviors);
        const second = projectBehaviorTimeline(steps, behaviors);

        expect(first).toEqual(second);
        expect(steps).toEqual(stepsBefore);
        expect(behaviors).toEqual(behaviorsBefore);
    });
});
