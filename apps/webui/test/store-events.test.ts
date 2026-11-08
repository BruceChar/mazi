import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { groupLiveStepsByTask, planViewOf } from '../src/scripts/plan-view.ts';

// --- Browser stubs. Must exist before the store module is imported, so the
// store is loaded with a dynamic import at the bottom (imports are hoisted). ---
(globalThis as any).document = { documentElement: { dataset: {} }, getElementById: () => null };
(globalThis as any).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

class FakeEventSource {
    static instances: FakeEventSource[] = [];
    private readonly listeners = new Map<string, ((event: { data: string }) => void)[]>();
    constructor(public readonly url: string) {
        FakeEventSource.instances.push(this);
    }
    addEventListener(type: string, cb: (event: { data: string }) => void): void {
        const list = this.listeners.get(type) ?? [];
        list.push(cb);
        this.listeners.set(type, list);
    }
    close(): void {}
    emit(type: string, data: unknown): void {
        for (const cb of this.listeners.get(type) ?? []) cb({ data: JSON.stringify(data) });
    }
}
(globalThis as any).EventSource = FakeEventSource;

const snapshot = {
    rootGoalId: 'run-1',
    goals: [
        {
            goalId: 'g1',
            kind: 'work',
            status: 'active',
            statement: 'do it',
            tasks: [
                {
                    taskId: 't1',
                    status: 'active',
                    title: 'do it',
                    steps: [{ stepId: 's1', kind: 'invocation', status: 'succeeded', startedAt: 1, endedAt: 2 }],
                },
            ],
        },
    ],
    taskCount: 1,
    stepCount: 1,
};

vi.mock('../src/api.js', () => ({
    API_BASE: '',
    logApi: () => {},
    api: vi.fn(async (path: string) => (path.includes('/timeline') ? snapshot : [])),
}));

// Avoid loading Vue's runtime-dom (it requires a full DOM); the store only uses
// ref/reactive/computed, so minimal stubs are enough to exercise its logic.
vi.mock('vue', () => ({
    ref: (value: unknown) => ({ value }),
    reactive: (value: unknown) => value,
    computed: (fn: () => unknown) => ({
        get value() {
            return fn();
        },
    }),
    // The store registers one module-level watcher (session permission).
    watch: () => () => {},
}));

const { liveSteps, runDetails, runPhases, runPlans, stopEvents, watchEvents } = await import(
    '../src/scripts/store.ts'
);

describe('webui live step refresh', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        FakeEventSource.instances.length = 0;
    });
    afterEach(() => {
        stopEvents();
        vi.useRealTimers();
    });

    it('goal.ended refreshes the per-run snapshot the chat renders (runDetails)', async () => {
        watchEvents('run-1');
        const source = FakeEventSource.instances.at(-1)!;
        source.emit('goal.ended', {
            eventId: 'e1',
            type: 'goal.ended',
            payload: { outcome: { status: 'success' } },
        });
        await vi.advanceTimersByTimeAsync(300);
        expect(runDetails['run-1']).toBeTruthy();
        expect(runDetails['run-1']?.stepCount).toBe(1);
        expect(runDetails['run-1']?.goals[0]?.tasks[0]?.steps[0]?.stepId).toBe('s1');
    });

    it('goal.negotiation.requested 触发重取 timeline（协商弹窗的数据来源）', async () => {
        delete runDetails['run-1'];
        watchEvents('run-1');
        const source = FakeEventSource.instances.at(-1)!;
        source.emit('goal.negotiation.requested', {
            eventId: 'n1',
            type: 'goal.negotiation.requested',
            payload: { route: 'negotiate', questions: [{ q: '文件在哪？', default: '停止' }] },
        });
        await vi.advanceTimersByTimeAsync(300);
        // 没有这次刷新，协商问题永远到不了 UI（弹窗就不会出现）
        expect(runDetails['run-1']?.stepCount).toBe(1);
    });

    it('live steps append on step.started and close the previous running step', () => {
        watchEvents('run-2');
        const source = FakeEventSource.instances.at(-1)!;
        source.emit('step.started', {
            eventId: 's1',
            type: 'step.started',
            taskId: 't1',
            stepId: 'a',
            payload: { kind: 'invocation', status: 'active', content: 'read README' },
        });
        source.emit('step.started', {
            eventId: 's2',
            type: 'step.started',
            taskId: 't1',
            stepId: 'b',
            payload: { kind: 'deliberation', status: 'succeeded', content: 'next thought' },
        });
        expect(liveSteps['run-2']?.map((step) => step.stepId)).toEqual(['a', 'b']);
        // Starting b closes a (the "next step starts, previous ends" rule).
        expect(liveSteps['run-2']?.[0]?.status).toBe('succeeded');
        expect(liveSteps['run-2']?.[0]?.endedAt).not.toBeNull();
    });

    it('step.ended updates the running tool call in place (no duplicate row)', () => {
        watchEvents('run-3');
        const source = FakeEventSource.instances.at(-1)!;
        source.emit('step.started', {
            eventId: 's1',
            type: 'step.started',
            taskId: 't1',
            stepId: 'a',
            payload: { kind: 'invocation', status: 'active', content: 'read README' },
        });
        source.emit('step.ended', {
            eventId: 's2',
            type: 'step.ended',
            taskId: 't1',
            stepId: 'a',
            payload: { kind: 'invocation', status: 'succeeded', content: 'read README' },
        });
        expect(liveSteps['run-3']).toHaveLength(1);
        expect(liveSteps['run-3']?.[0]?.status).toBe('succeeded');
    });

    it('goal.phase 更新对应 rootGoalId 的 runPhases（阶段 + label + 事件时刻）', () => {
        watchEvents('run-4');
        const source = FakeEventSource.instances.at(-1)!;
        const startedAt = Date.now() - 3000;
        source.emit('goal.phase', {
            eventId: 'p1',
            type: 'goal.phase',
            rootGoalId: 'run-4',
            timestamp: startedAt,
            payload: { phase: 'intake' },
        });
        expect(runPhases['run-4']?.phase).toBe('intake');
        expect(runPhases['run-4']?.label).toBeUndefined();
        // 用事件时刻而不是本地到达时刻：SSE 回放时已等待秒数仍然真实。
        expect(runPhases['run-4']?.at).toBe(startedAt);
        expect(runPhases['run-5']).toBeUndefined();

        const planningAt = Date.now();
        source.emit('goal.phase', {
            eventId: 'p2',
            type: 'goal.phase',
            rootGoalId: 'run-4',
            timestamp: planningAt,
            payload: { phase: 'planning', label: '正在制定计划' },
        });
        expect(runPhases['run-4']?.phase).toBe('planning');
        expect(runPhases['run-4']?.label).toBe('正在制定计划');
        expect(runPhases['run-4']?.at).toBe(planningAt);

        // 事件缺失 rootGoalId 时回退到当前订阅的 run（SSE 回放/推送两种来源都不丢）。
        source.emit('goal.phase', {
            eventId: 'p3',
            type: 'goal.phase',
            payload: { phase: 'executing' },
        });
        expect(runPhases['run-4']?.phase).toBe('executing');
    });

    it('stopEvents 清空 runPhases（切换会话不残留上一个 run 的阶段行）', () => {
        watchEvents('run-6');
        const source = FakeEventSource.instances.at(-1)!;
        source.emit('goal.phase', {
            eventId: 'p4',
            type: 'goal.phase',
            rootGoalId: 'run-6',
            payload: { phase: 'intake' },
        });
        expect(runPhases['run-6']?.phase).toBe('intake');
        stopEvents();
        expect(runPhases['run-6']).toBeUndefined();
    });

    it('运行收尾事件清掉阶段态（避免下一次「继续」闪现旧阶段与巨大的已等待秒数）', async () => {
        watchEvents('run-7');
        const source = FakeEventSource.instances.at(-1)!;
        source.emit('goal.phase', {
            eventId: 'p5',
            type: 'goal.phase',
            rootGoalId: 'run-7',
            payload: { phase: 'planning', label: '正在制定计划' },
        });
        expect(runPhases['run-7']?.phase).toBe('planning');
        source.emit('goal.ended', {
            eventId: 'g1',
            type: 'goal.ended',
            rootGoalId: 'run-7',
            payload: { outcome: { status: 'success' } },
        });
        expect(runPhases['run-7']).toBeUndefined();
        await vi.advanceTimersByTimeAsync(300);
    });

    it('plan.created 归约为当前计划（planVersion + 完整 tasks），并触发 timeline 刷新', async () => {
        watchEvents('plan-1');
        const source = FakeEventSource.instances.at(-1)!;
        source.emit('plan.created', {
            eventId: 'pc1',
            type: 'plan.created',
            rootGoalId: 'plan-1',
            timestamp: 1000,
            payload: {
                taskCount: 2,
                digest: 'd1',
                planVersion: 1,
                tasks: [
                    { taskId: 't1', title: '扫描仓库', dependsOn: [], planVersion: 1 },
                    { taskId: 't2', title: '汇总结果', dependsOn: ['t1'], planVersion: 1 },
                ],
            },
        });
        expect(runPlans['plan-1']?.planVersion).toBe(1);
        expect(runPlans['plan-1']?.revision).toBe(0);
        expect(runPlans['plan-1']?.tasks.map((task) => task.taskId)).toEqual(['t1', 't2']);
        expect(runPlans['plan-1']?.tasks[1]?.dependsOn).toEqual(['t1']);
        // 事件时刻用于渲染计划头的「更新于」，不用本地到达时刻。
        expect(runPlans['plan-1']?.updatedAt).toBe(1000);
        // plan.created 在 REFRESH_EVENT_TYPES 里：防抖刷新 timeline 补齐契约/落库状态。
        await vi.advanceTimersByTimeAsync(300);
        expect(runDetails['plan-1']?.stepCount).toBe(1);
    });

    it('plan.revised 用修订后的完整计划覆盖归约结果，迟到的旧版本事件不覆盖', () => {
        watchEvents('plan-2');
        const source = FakeEventSource.instances.at(-1)!;
        source.emit('plan.created', {
            eventId: 'pc2',
            type: 'plan.created',
            rootGoalId: 'plan-2',
            timestamp: 1000,
            payload: {
                planVersion: 1,
                tasks: [{ taskId: 't1', title: '扫描仓库', planVersion: 1 }],
            },
        });
        source.emit('plan.revised', {
            eventId: 'pr2',
            type: 'plan.revised',
            rootGoalId: 'plan-2',
            timestamp: 2000,
            payload: {
                revision: 1,
                planVersion: 2,
                reason: 'verifier:failed',
                tasks: [
                    { taskId: 't1', title: '扫描仓库（补救）', dependsOn: [], planVersion: 2, status: 'active' },
                    { taskId: 't2', title: '汇总结果', dependsOn: ['t1'], planVersion: 2, status: 'pending' },
                ],
            },
        });
        expect(runPlans['plan-2']?.planVersion).toBe(2);
        expect(runPlans['plan-2']?.revision).toBe(1);
        expect(runPlans['plan-2']?.tasks).toHaveLength(2);
        expect(runPlans['plan-2']?.tasks[0]?.status).toBe('active');
        expect(runPlans['plan-2']?.updatedAt).toBe(2000);

        // 旧版本事件迟到（SSE 重放/乱序）不能把当前计划打回 v1。
        source.emit('plan.created', {
            eventId: 'pc2-late',
            type: 'plan.created',
            rootGoalId: 'plan-2',
            timestamp: 500,
            payload: { planVersion: 1, tasks: [{ taskId: 'old', title: '旧计划', planVersion: 1 }] },
        });
        expect(runPlans['plan-2']?.planVersion).toBe(2);
        expect(runPlans['plan-2']?.tasks.map((task) => task.taskId)).toEqual(['t1', 't2']);
    });

    it('旧 runtime 的计划事件缺 planVersion / tasks 时优雅降级', () => {
        watchEvents('plan-3');
        const source = FakeEventSource.instances.at(-1)!;
        // plan.created：旧 payload 只有 taskCount/digest（tasks 是后来才加的）。
        source.emit('plan.created', {
            eventId: 'pc3',
            type: 'plan.created',
            rootGoalId: 'plan-3',
            payload: { taskCount: 2, digest: 'd3' },
        });
        expect(runPlans['plan-3']?.planVersion).toBe(1);
        expect(runPlans['plan-3']?.revision).toBe(0);
        expect(runPlans['plan-3']?.tasks).toEqual([]);
        // plan.revised：旧 payload 只有 revision/diff/reason，没有 planVersion/tasks。
        // 版本仍前进一步（计划头能显示已修订），tasks 清空 → ExecStream 回退到快照过滤。
        source.emit('plan.revised', {
            eventId: 'pr3',
            type: 'plan.revised',
            rootGoalId: 'plan-3',
            payload: { revision: 1, reason: 'verifier:failed', diff: { added: [], removed: [], retained: [] } },
        });
        expect(runPlans['plan-3']?.planVersion).toBe(2);
        expect(runPlans['plan-3']?.revision).toBe(1);
        expect(runPlans['plan-3']?.tasks).toEqual([]);
    });

    it('plan.invalid 不产生计划、不影响已有计划', () => {
        watchEvents('plan-4');
        const source = FakeEventSource.instances.at(-1)!;
        source.emit('plan.invalid', {
            eventId: 'pi4',
            type: 'plan.invalid',
            rootGoalId: 'plan-4',
            payload: { taskCount: 2, rejected: ['重复计划'] },
        });
        expect(runPlans['plan-4']).toBeUndefined();
    });

    it('stopEvents 清空 runPlans（切换会话不残留上一个 run 的计划树）', () => {
        watchEvents('plan-5');
        const source = FakeEventSource.instances.at(-1)!;
        source.emit('plan.created', {
            eventId: 'pc5',
            type: 'plan.created',
            rootGoalId: 'plan-5',
            payload: { planVersion: 1, tasks: [{ taskId: 't1', title: '任务', planVersion: 1 }] },
        });
        expect(runPlans['plan-5']?.tasks).toHaveLength(1);
        stopEvents();
        expect(runPlans['plan-5']).toBeUndefined();
    });

    it('计划事件 + 实时步骤可组装出执行中的当前计划树（分组/状态/步数）', () => {
        watchEvents('plan-6');
        const source = FakeEventSource.instances.at(-1)!;
        source.emit('plan.created', {
            eventId: 'pc6',
            type: 'plan.created',
            rootGoalId: 'plan-6',
            timestamp: 1000,
            payload: {
                planVersion: 1,
                tasks: [
                    { taskId: 't1', title: '扫描仓库', dependsOn: [], planVersion: 1 },
                    { taskId: 't2', title: '汇总结果', dependsOn: ['t1'], planVersion: 1 },
                ],
            },
        });
        // 第一次 replan：整棵当前计划升到 v2，t1 保留并改写标题，t2 仍是 pending。
        source.emit('plan.revised', {
            eventId: 'pr6',
            type: 'plan.revised',
            rootGoalId: 'plan-6',
            timestamp: 1500,
            payload: {
                revision: 1,
                planVersion: 2,
                tasks: [
                    { taskId: 't1', title: '扫描仓库（补救）', dependsOn: [], planVersion: 2, status: 'active' },
                    { taskId: 't2', title: '汇总结果', dependsOn: ['t1'], planVersion: 2, status: 'pending' },
                ],
            },
        });
        source.emit('step.started', {
            eventId: 'st6',
            type: 'step.started',
            rootGoalId: 'plan-6',
            taskId: 't1',
            stepId: 's1',
            payload: { kind: 'invocation', status: 'active', content: 'read README' },
        });
        // ExecStream 的实时计划投影：计划事件归约结果 + 实时步骤 → 树
        const view = planViewOf({
            plan: runPlans['plan-6'],
            snapshot: null,
            liveSteps: liveSteps['plan-6'] ?? [],
        });
        expect(view.planVersion).toBe(2);
        expect(view.revisions).toBe(1);
        expect(view.tasks.map((task) => task.taskId)).toEqual(['t1', 't2']);
        expect(view.tasks[0]?.title).toBe('扫描仓库（补救）');
        expect(view.tasks[0]?.statusLabel).toBe('执行中');
        expect(view.tasks[1]?.statusLabel).toBe('待执行');
        const grouped = groupLiveStepsByTask(
            (liveSteps['plan-6'] ?? []).map((step) => ({ step })),
            view.tasks,
        );
        expect(grouped.groups.map((group) => [group.task?.taskId, group.entries.length])).toEqual([
            ['t1', 1],
            ['t2', 0],
        ]);
        expect(grouped.unassigned).toEqual([]);
    });
});
