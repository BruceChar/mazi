import { describe, expect, it } from 'vitest';

import {
    groupLiveStepsByTask,
    latestPlanTasks,
    planRevisionLabel,
    planRevisions,
    planRouteLabel,
    planTaskStatusLabel,
    planTaskStatusTone,
    planVersionLabel,
    planVersionOf,
    planViewOf,
    supersededAttemptCount,
} from '../src/scripts/plan-view.ts';

/** 计划 Task 构造器：默认标题可预测，便于断言。 */
function task(taskId: string, extra: Record<string, unknown> = {}) {
    return { taskId, title: `任务 ${taskId}`, ...extra };
}

function stepEntry(taskId: string, stepId: string, status = 'succeeded') {
    return { step: { taskId, stepId, status } };
}

describe('plan-view 计划版本', () => {
    it('取一批 Task 的最高 planVersion；没有版本信息时为 null', () => {
        expect(planVersionOf(null)).toBeNull();
        expect(planVersionOf([])).toBeNull();
        expect(planVersionOf([task('t1'), task('t2')])).toBeNull();
        expect(planVersionOf([task('t1', { planVersion: 1 }), task('t2', { planVersion: 3 })])).toBe(
            3,
        );
        // 非数字/NaN 版本号一律忽略（旧数据的防御式降级）。
        expect(planVersionOf([{ taskId: 't', title: 'x', planVersion: '2' as unknown as number }])).toBeNull();
    });

    it('latestPlanTasks 只保留最高版本的一批，并保持计划顺序', () => {
        const tasks = [
            task('old-1', { planVersion: 1 }),
            task('cur-1', { planVersion: 2 }),
            task('old-2', { planVersion: 1 }),
            task('cur-2', { planVersion: 2 }),
        ];
        expect(latestPlanTasks(tasks).map((item) => item.taskId)).toEqual(['cur-1', 'cur-2']);
    });

    it('没有任何版本信息（历史数据）时原样返回，不做过滤', () => {
        const tasks = [task('t1'), task('t2')];
        const filtered = latestPlanTasks(tasks);
        expect(filtered.map((item) => item.taskId)).toEqual(['t1', 't2']);
        // 返回新数组，展示层不会反向改动快照数据。
        expect(filtered).not.toBe(tasks);
        expect(latestPlanTasks(null)).toEqual([]);
    });

    it('修订次数 = 版本 - 1（初始计划 v1 不算修订）', () => {
        expect(planRevisions(null)).toBe(0);
        expect(planRevisions(1)).toBe(0);
        expect(planRevisions(2)).toBe(1);
        expect(planRevisions(4)).toBe(3);
    });

    it('计划 chip / 修订 chip 文案', () => {
        expect(planVersionLabel(1)).toBe('计划 v1');
        expect(planVersionLabel(3)).toBe('计划 v3');
        expect(planVersionLabel(null)).toBe('');
        expect(planRevisionLabel(0)).toBe('');
        expect(planRevisionLabel(2)).toBe('已修订 2 次');
    });
});

describe('plan-view 状态与路线文案', () => {
    it('Task 状态映射为中文徽标', () => {
        expect(planTaskStatusLabel('pending')).toBe('待执行');
        expect(planTaskStatusLabel('active')).toBe('执行中');
        expect(planTaskStatusLabel('succeeded')).toBe('成功');
        expect(planTaskStatusLabel('failed')).toBe('失败');
        expect(planTaskStatusLabel('aborted')).toBe('已中止');
        expect(planTaskStatusLabel('skipped')).toBe('跳过');
        // 未知 status 原样展示，缺失按待执行处理。
        expect(planTaskStatusLabel('weird')).toBe('weird');
        expect(planTaskStatusLabel(undefined)).toBe('待执行');
    });

    it('Task 状态映射为色调 class', () => {
        expect(planTaskStatusTone('pending')).toBe('pending');
        expect(planTaskStatusTone('active')).toBe('running');
        expect(planTaskStatusTone('succeeded')).toBe('ok');
        expect(planTaskStatusTone('failed')).toBe('fail');
        expect(planTaskStatusTone('aborted')).toBe('aborted');
        expect(planTaskStatusTone('skipped')).toBe('skipped');
        expect(planTaskStatusTone('weird')).toBe('');
        expect(planTaskStatusTone(undefined)).toBe('pending');
    });

    it('triage 路线用短标签（直答/已确认/协商/升级/回退）', () => {
        expect(planRouteLabel('direct')).toBe('直答');
        expect(planRouteLabel('confirmed')).toBe('已确认');
        expect(planRouteLabel('negotiate')).toBe('协商');
        expect(planRouteLabel('escalate')).toBe('升级');
        expect(planRouteLabel('fallback')).toBe('回退');
        expect(planRouteLabel(undefined)).toBe('');
    });
});

describe('plan-view 当前计划投影', () => {
    it('计划事件优先于快照：事件里的完整 Task 列表就是当前计划', () => {
        const view = planViewOf({
            plan: {
                planVersion: 2,
                revision: 1,
                tasks: [
                    task('t1', { planVersion: 2, status: 'active' }),
                    task('t2', { planVersion: 2, status: 'pending' }),
                ],
            },
            snapshot: {
                goals: [
                    {
                        tasks: [
                            task('old', { planVersion: 1, status: 'failed' }),
                            task('t1', { planVersion: 2, status: 'active' }),
                            task('t2', { planVersion: 2, status: 'pending' }),
                        ],
                    },
                ],
            },
        });
        expect(view.planVersion).toBe(2);
        expect(view.revisions).toBe(1);
        expect(view.tasks.map((row) => row.taskId)).toEqual(['t1', 't2']);
        // 被 replan 替换的旧计划 Task：不进入当前计划树，只计数提示。
        expect(view.supersededCount).toBe(1);
    });

    it('没有计划事件时回退到快照：按最高 planVersion 过滤', () => {
        const view = planViewOf({
            snapshot: {
                goals: [
                    {
                        tasks: [
                            task('old-1', { planVersion: 1 }),
                            task('old-2', { planVersion: 1 }),
                            task('cur-1', { planVersion: 2, status: 'succeeded' }),
                            task('cur-2', { planVersion: 2, status: 'pending' }),
                        ],
                    },
                ],
            },
        });
        expect(view.planVersion).toBe(2);
        expect(view.revisions).toBe(1);
        expect(view.tasks.map((row) => row.taskId)).toEqual(['cur-1', 'cur-2']);
        expect(view.supersededCount).toBe(2);
    });

    it('历史数据没有 planVersion：显示整棵树、不显示修订（优雅降级）', () => {
        const view = planViewOf({
            snapshot: {
                goals: [{ tasks: [task('t1', { status: 'succeeded' }), task('t2')] }],
            },
        });
        expect(view.planVersion).toBeNull();
        expect(view.revisions).toBe(0);
        expect(view.tasks).toHaveLength(2);
        expect(view.supersededCount).toBe(0);
    });

    it('Task 状态优先取事件/快照的落库 status，步数取快照与实时的较大值', () => {
        const view = planViewOf({
            snapshot: {
                goals: [
                    {
                        tasks: [
                            task('t1', {
                                planVersion: 2,
                                steps: [{}, {}, {}],
                            }),
                        ],
                    },
                ],
            },
            plan: { planVersion: 2, tasks: [task('t1', { planVersion: 2 })] },
            liveSteps: [
                { taskId: 't1', status: 'succeeded' },
                { taskId: 't1', status: 'active' },
            ],
        });
        expect(view.tasks[0]?.status).toBe('active');
        expect(view.tasks[0]?.statusLabel).toBe('执行中');
        expect(view.tasks[0]?.stepCount).toBe(3);
    });

    it('事件与快照都缺 status 时按实时步骤推断：有步骤=执行中，无步骤=待执行', () => {
        const view = planViewOf({
            plan: { planVersion: 1, tasks: [task('running'), task('queued')] },
            liveSteps: [{ taskId: 'running', status: 'active' }],
        });
        expect(view.tasks.map((row) => row.statusLabel)).toEqual(['执行中', '待执行']);
    });

    it('plan.created 的任务没有 status、快照也没有时显示「待执行」（计划先于步骤可见）', () => {
        const view = planViewOf({ plan: { planVersion: 1, tasks: [task('t1'), task('t2')] } });
        expect(view.tasks.map((row) => row.statusLabel)).toEqual(['待执行', '待执行']);
        expect(view.tasks.map((row) => row.stepCount)).toEqual([0, 0]);
    });

    it('事件 tasks 为空（旧 runtime）时用事件版本号 + 快照 Task 降级', () => {
        const view = planViewOf({
            plan: { planVersion: 2, revision: 1, tasks: [] },
            snapshot: {
                goals: [
                    {
                        tasks: [
                            task('cur-1', { planVersion: 2, status: 'active' }),
                            task('cur-2', { planVersion: 2, status: 'pending' }),
                        ],
                    },
                ],
            },
        });
        expect(view.planVersion).toBe(2);
        expect(view.tasks.map((row) => row.taskId)).toEqual(['cur-1', 'cur-2']);
    });

    it('按 taskId 去重、标题回退到快照、无标题回退到 taskId', () => {
        const view = planViewOf({
            plan: {
                planVersion: 1,
                tasks: [
                    task('t1', { title: '' }),
                    task('t1'),
                    { taskId: 't2', title: '' } as never,
                ],
            },
            snapshot: { goals: [{ tasks: [task('t1', { title: '快照标题' })] }] },
        });
        expect(view.tasks.map((row) => row.taskId)).toEqual(['t1', 't2']);
        expect(view.tasks[0]?.title).toBe('快照标题');
        expect(view.tasks[1]?.title).toBe('t2');
    });

    it('空快照 + 空计划返回空树', () => {
        const view = planViewOf({});
        expect(view.planVersion).toBeNull();
        expect(view.revisions).toBe(0);
        expect(view.tasks).toEqual([]);
        expect(view.supersededCount).toBe(0);
    });
});

describe('plan-view 实时步骤分组', () => {
    const rows = [
        { taskId: 't1', title: '任务一', status: 'active', statusLabel: '执行中', tone: 'running' as const, stepCount: 1 },
        { taskId: 't2', title: '任务二', status: 'pending', statusLabel: '待执行', tone: 'pending' as const, stepCount: 0 },
    ];

    it('按计划顺序分组，步骤保持到达顺序', () => {
        const entries = [stepEntry('t1', 's1'), stepEntry('t2', 's2'), stepEntry('t1', 's3')];
        const grouped = groupLiveStepsByTask(entries, rows);
        expect(grouped.groups.map((group) => group.task?.taskId)).toEqual(['t1', 't2']);
        expect(grouped.groups[0]?.entries.map((entry) => entry.step.stepId)).toEqual(['s1', 's3']);
        expect(grouped.groups[1]?.entries.map((entry) => entry.step.stepId)).toEqual(['s2']);
        expect(grouped.unassigned).toEqual([]);
    });

    it('0 step 的 Task 得到空分组（外层渲染「待执行」提示）', () => {
        const grouped = groupLiveStepsByTask([stepEntry('t1', 's1')], rows);
        expect(grouped.groups[1]?.task?.taskId).toBe('t2');
        expect(grouped.groups[1]?.entries).toEqual([]);
    });

    it('不属于当前计划的步骤进入 unassigned（旧计划尝试）', () => {
        const entries = [stepEntry('t1', 's1'), stepEntry('old', 's2'), stepEntry('', 's3')];
        const grouped = groupLiveStepsByTask(entries, rows);
        expect(grouped.groups[0]?.entries).toHaveLength(1);
        expect(grouped.unassigned.map((entry) => entry.step.stepId)).toEqual(['s2', 's3']);
    });

    it('计划未知时退回单个 task=null 的扁平组（保持旧实时列表行为）', () => {
        const entries = [stepEntry('t1', 's1'), stepEntry('t2', 's2')];
        const grouped = groupLiveStepsByTask(entries, []);
        expect(grouped.groups).toHaveLength(1);
        expect(grouped.groups[0]?.task).toBeNull();
        expect(grouped.groups[0]?.entries.map((entry) => entry.step.stepId)).toEqual(['s1', 's2']);
        expect(grouped.unassigned).toEqual([]);
        expect(groupLiveStepsByTask(null, null).groups).toEqual([{ task: null, entries: [] }]);
    });
});

describe('plan-view 已替换计划尝试计数', () => {
    const baseView = {
        planVersion: 2,
        revisions: 1,
        tasks: [],
        supersededCount: 2,
    };

    it('快照里被过滤的旧 Task 数优先', () => {
        expect(supersededAttemptCount(baseView, [])).toBe(2);
    });

    it('快照尚未刷新时用无归属实时步骤的去重 Task 数兜底', () => {
        const view = { ...baseView, supersededCount: 0 };
        const unassigned = [stepEntry('old-a', 's1'), stepEntry('old-a', 's2'), stepEntry('old-b', 's3')];
        expect(supersededAttemptCount(view, unassigned)).toBe(2);
    });

    it('没有旧计划尝试时为 0', () => {
        expect(
            supersededAttemptCount({ ...baseView, supersededCount: 0 }, []),
        ).toBe(0);
    });
});
