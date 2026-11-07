import { describe, expect, it } from 'vitest';
import type { BehaviorRow } from '../src/scripts/behavior-rows.ts';
import { behaviorRowsOf } from '../src/scripts/behavior-rows.ts';
import { placeBehaviors } from '../src/scripts/behavior-placement.ts';

/** Build real behavior rows through the projection (at === behavior.ts). */
function rowsOf(ats: readonly number[]): BehaviorRow[] {
    return behaviorRowsOf(
        [],
        ats.map((ts) => ({ ts, type: 'feedback', data: { kind: 'text', text: String(ts) } })),
    );
}

/** Hand-built row: lets the stability test control the input order. */
function row(at: number): BehaviorRow {
    return {
        key: 'behavior-' + at,
        type: 'feedback',
        at,
        icon: 'userMessage',
        label: '反馈',
        summary: String(at),
        behavior: { ts: at, type: 'feedback', data: {} },
    };
}

interface TestStep {
    stepId: string;
    startedAt: number;
    endedAt?: number | null;
    status?: string;
}

function step(
    stepId: string,
    startedAt: number,
    endedAt?: number | null,
    status?: string,
): TestStep {
    return { stepId, startedAt, endedAt, status };
}

describe('placeBehaviors（行为行 → Step 时间窗归属）', () => {
    it('落在 [startedAt, endedAt) 内的行为挂到该 Step（右开区间）', () => {
        const result = placeBehaviors([step('s1', 100, 200)], rowsOf([50, 100, 150, 199, 200]));
        expect(result.steps.map((group) => group.step.stepId)).toEqual(['s1']);
        expect(result.steps[0]?.behaviors.map((row) => row.at)).toEqual([100, 150, 199]);
        expect(result.trailing.map((row) => row.at)).toEqual([50, 200]);
    });

    it('endedAt 缺失或为 null 视为开放窗口（pending/active 实时 Step）', () => {
        const open = placeBehaviors([step('open', 100, null)], rowsOf([99, 100, 5000]));
        expect(open.steps[0]?.behaviors.map((row) => row.at)).toEqual([100, 5000]);
        expect(open.trailing.map((row) => row.at)).toEqual([99]);

        const missing = placeBehaviors([step('open', 100)], rowsOf([100, 200]));
        expect(missing.steps[0]?.behaviors.map((row) => row.at)).toEqual([100, 200]);
    });

    it('多个窗口命中时取 startedAt 最大者（嵌套 / later Step 优先）', () => {
        const result = placeBehaviors(
            [step('outer', 0, 1000), step('inner', 100, 300)],
            rowsOf([50, 200, 500]),
        );
        expect(result.steps.map((group) => group.behaviors.map((row) => row.at))).toEqual([
            [50, 500],
            [200],
        ]);
    });

    it('没有归属的行为进 trailing（run 结束后的反馈渲染在最后）', () => {
        const result = placeBehaviors([step('s1', 100, 200)], rowsOf([250, 300]));
        expect(result.steps[0]?.behaviors).toEqual([]);
        expect(result.trailing.map((row) => row.at)).toEqual([250, 300]);
    });

    it('空输入：空 Step / 空行为均安全返回', () => {
        expect(placeBehaviors([], [])).toEqual({ steps: [], trailing: [] });
        const stepsOnly = placeBehaviors([step('s1', 0, 10)], []);
        expect(stepsOnly.steps[0]?.behaviors).toEqual([]);
        expect(stepsOnly.trailing).toEqual([]);
    });

    it('同轮多个 pending 开放窗口时优先挂 active Step（正在等待授权的工具步）', () => {
        const result = placeBehaviors(
            [
                step('pending-a', 100, null, 'pending'),
                step('active', 120, null, 'active'),
                step('pending-b', 150, null, 'pending'),
            ],
            rowsOf([180]),
        );
        expect(result.steps.map((group) => group.behaviors.length)).toEqual([0, 1, 0]);
        expect(result.steps[1]?.step.stepId).toBe('active');
    });

    it('结算快照中 pending 开放窗口与已结束 Step 同时命中时优先已结束 Step', () => {
        const result = placeBehaviors(
            [step('ended', 100, 200, 'succeeded'), step('pending', 150, null, 'pending')],
            rowsOf([180]),
        );
        expect(result.steps.map((group) => group.behaviors.length)).toEqual([1, 0]);
        expect(result.steps[0]?.step.stepId).toBe('ended');
    });

    it('无 active 且无有限窗口时按 startedAt 最大兜底（并列取数组靠后者）', () => {
        const open = placeBehaviors(
            [step('early', 100, null, 'pending'), step('later', 200, null, 'pending')],
            rowsOf([300]),
        );
        expect(open.steps[1]?.behaviors.map((row) => row.at)).toEqual([300]);

        const tie = placeBehaviors(
            [step('first', 100, null, 'pending'), step('second', 100, null, 'pending')],
            rowsOf([150]),
        );
        expect(tie.steps[1]?.behaviors.map((row) => row.at)).toEqual([150]);
    });

    it('同 Step 内保持输入顺序，且不修改输入', () => {
        const steps = [step('s1', 100, 200)];
        const rows = [row(150), row(120), row(180)];
        const stepsBefore = structuredClone(steps);
        const rowsBefore = structuredClone(rows);

        const result = placeBehaviors(steps, rows);

        expect(result.steps[0]?.behaviors.map((row) => row.at)).toEqual([150, 120, 180]);
        expect(steps).toEqual(stepsBefore);
        expect(rows).toEqual(rowsBefore);
    });
});
