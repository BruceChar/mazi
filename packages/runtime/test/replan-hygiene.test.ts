import type { Goal, Step, Task, ULID } from '@mazi/core';
import { ulid } from '@mazi/core';
import { describe, expect, it } from 'vitest';
import type { ReplanRequest } from '../src/gts/replan.js';
import type { RoundResult } from '../src/gts/round-types.js';
import { MemoryGoalStore } from '../src/memory/goal-store.js';
import { runGoalTree } from '../src/strategy/goal-strategy.js';
import type { TaskVerifier, VerificationReport } from '../src/verifier/index.js';

function goal(): Goal {
    return {
        goalId: ulid(),
        statement: '扫描仓库待办并汇总',
        contract: {
            successConditions: [
                {
                    id: ulid(),
                    checkType: 'deterministic',
                    check: { kind: 'final-answer' },
                },
            ],
            failureConditions: [],
            forbiddenResources: [],
            budget: { maxCostUsd: 10 },
            terminationPolicy: { maxSteps: 10 },
            riskProfile: {
                hasIrreversibleActions: false,
                touchesNetwork: false,
                touchesExternalApi: false,
            },
        },
        permissionCeiling: 'workspace-write',
        budget: { maxCostUsd: 10 },
        status: 'active',
        createdAt: 1,
    };
}

const okRound: RoundResult = {
    text: '阶段完成。',
    reasoning: '',
    toolCalls: [],
    finishReason: 'stop',
    ttftMs: 0,
    totalMs: 1,
};

/** 指定标题的 Task 验收失败，其余通过；避免依赖真实文件系统/网络。 */
function failingVerifier(failedTitles: readonly string[]): TaskVerifier {
    return {
        id: 'test-verifier',
        async verify(_goal, outcome): Promise<VerificationReport> {
            const failed = failedTitles.includes(outcome.task.title);
            return {
                verifierId: 'test-verifier',
                state: failed ? 'failed' : 'passed',
                acceptance: {
                    checkedAt: 1,
                    passed: !failed,
                    evaluated: 1,
                    total: 1,
                    conditions: [],
                },
                evidence: failed ? [`${outcome.task.title} 验收失败`] : [],
                checkedAt: 1,
            };
        },
    };
}

function task(id: string, goalId: ULID, title: string, status: Task['status']): Task {
    return {
        taskId: id as ULID,
        goalId,
        title,
        acceptance: { conditions: [] },
        status,
    };
}

function step(id: ULID, taskId: ULID, goalId: ULID): Step {
    return {
        stepId: id,
        taskId,
        goalId,
        kind: 'deliberation',
        payload: { answer: 'x' },
        status: 'succeeded',
        startedAt: 1,
    };
}

describe('replan 计划代际卫生（剩余 Task 保留 / 孤儿删除 / planVersion）', () => {
    it('剩余 Task 跨多次 replan 原样保留（不复制）、依赖重映射、planVersion 递增', async () => {
        const store = new MemoryGoalStore();
        const target = goal();
        await store.saveGoal(target);
        const condition = target.contract.successConditions[0]!.id;

        let initialTasks: readonly Task[] = [];
        const replanRequests: ReplanRequest[] = [];
        const result = await runGoalTree(
            {
                store,
                verifier: failingVerifier(['扫描待办', '补救一']),
                requestRound: async () => okRound,
                planProposal: [
                    {
                        key: 'prepare',
                        title: '准备工具',
                        acceptanceConditionIds: [condition],
                    },
                    {
                        key: 'scan',
                        title: '扫描待办',
                        dependsOn: ['prepare'],
                        acceptanceConditionIds: [condition],
                    },
                    {
                        key: 'report',
                        title: '汇总结果',
                        dependsOn: ['scan'],
                        acceptanceConditionIds: [condition],
                    },
                ],
                onPlan: (_taskCount, _digest, _rejected, tasks) => {
                    if (tasks !== undefined) initialTasks = tasks;
                },
                replan: {
                    maxReplans: 2,
                    planner: async (request) => {
                        replanRequests.push(request);
                        const call = replanRequests.length;
                        return [
                            {
                                key: `fix-${call}`,
                                title: call === 1 ? '补救一' : '补救二',
                                acceptanceConditionIds: [condition],
                            },
                        ];
                    },
                },
            },
            [target],
        );

        // 每次 replan 的输入都带上「尚未执行」的剩余 Task；失败的 Task 不属于剩余。
        expect(replanRequests.map((request) => request.revision)).toEqual([0, 1]);
        expect(replanRequests[0]?.remainingTasks.map((item) => item.title)).toEqual(['汇总结果']);
        expect(replanRequests[1]?.remainingTasks.map((item) => item.title)).toEqual(['汇总结果']);

        // 补救一失败后再次 replan：剩余 Task 依然原样保留，planVersion 依次 2 → 3。
        expect(result.planRevisions?.map((revision) => revision.planVersion)).toEqual([2, 3]);
        expect(result.planRevisions?.map((revision) => revision.revision)).toEqual([1, 2]);
        // revision tasks = 已完成 + 尚未执行 + 本次补救 Task（顺序稳定）。
        expect(result.planRevisions?.[0]?.tasks.map((item) => item.title)).toEqual([
            '准备工具',
            '汇总结果',
            '补救一',
        ]);
        expect(result.planRevisions?.[1]?.tasks.map((item) => item.title)).toEqual([
            '准备工具',
            '汇总结果',
            '补救二',
        ]);

        const prepareTaskId = initialTasks.find((item) => item.title === '准备工具')?.taskId;
        const reportTaskId = initialTasks.find((item) => item.title === '汇总结果')?.taskId;
        expect(reportTaskId).toBeDefined();
        for (const revision of result.planRevisions ?? []) {
            const reportTasks = revision.tasks.filter((item) => item.title === '汇总结果');
            // 同一 taskId 原样保留，不因 replan 复制出新 Task。
            expect(reportTasks).toHaveLength(1);
            expect(reportTasks[0]?.taskId).toBe(reportTaskId);
            expect(reportTasks[0]?.planVersion).toBe(revision.planVersion);
        }
        const firstRevision = result.planRevisions?.[0];
        const secondRevision = result.planRevisions?.[1];
        const firstFix = firstRevision?.tasks.find((item) => item.title === '补救一');
        const secondFix = secondRevision?.tasks.find((item) => item.title === '补救二');
        // 汇总结果依赖了失败的扫描 Task：revision 1 重映射到补救一，revision 2 重映射到补救二。
        expect(
            firstRevision?.tasks.find((item) => item.taskId === reportTaskId)?.dependsOn,
        ).toEqual([firstFix?.taskId]);
        expect(
            secondRevision?.tasks.find((item) => item.taskId === reportTaskId)?.dependsOn,
        ).toEqual([secondFix?.taskId]);

        // 最终只执行了最后一次计划：准备工具（已完成跳过）→ 补救二 → 汇总结果。
        expect(result.ok).toBe(true);
        expect(result.tasks.map((outcome) => outcome.task.title)).toEqual([
            '准备工具',
            '补救二',
            '汇总结果',
        ]);
        // 已完成的 Task 也只出现一次，并随计划版本升级。
        for (const revision of result.planRevisions ?? []) {
            expect(revision.tasks.filter((item) => item.taskId === prepareTaskId)).toHaveLength(1);
        }
        expect(
            secondRevision?.tasks.find((item) => item.taskId === prepareTaskId)?.planVersion,
        ).toBe(3);

        const stored = await store.listTasks(target.goalId);
        // 失败的两次尝试保留供审计；没有 pending 残留，也没有重复的汇总 Task。
        expect(stored.filter((item) => item.status === 'failed').map((item) => item.title)).toEqual([
            '扫描待办',
            '补救一',
        ]);
        expect(stored.filter((item) => item.status === 'pending')).toEqual([]);
        expect(stored.filter((item) => item.title === '汇总结果')).toHaveLength(1);
        expect(stored.find((item) => item.title === '汇总结果')?.planVersion).toBe(3);
        expect(stored.find((item) => item.title === '补救二')?.planVersion).toBe(3);
    });

    it('删除被替换的孤儿 pending 零 Step Task，保留失败尝试与已有 Step 的行', async () => {
        const store = new MemoryGoalStore();
        const target = goal();
        await store.saveGoal(target);
        const condition = target.contract.successConditions[0]!.id;
        // 历史 revision 遗留：从未执行过的 pending 零 Step 孤儿。
        const orphan = task('orphan', target.goalId, '旧计划残留', 'pending');
        await store.saveTask(orphan);
        // 失败尝试必须保留（审计）。
        const failedAttempt = task('old-failed', target.goalId, '上一轮失败尝试', 'failed');
        await store.saveTask(failedAttempt);
        // 有 Step 的 pending 行不删（安全下限：只清理零 Step 的孤儿）。
        const pendingWithStep = task('pending-step', target.goalId, '异常 pending 行', 'pending');
        await store.saveTask(pendingWithStep);
        await store.saveStep(step(ulid(), pendingWithStep.taskId, target.goalId));

        const result = await runGoalTree(
            {
                store,
                verifier: failingVerifier(['扫描待办']),
                requestRound: async () => okRound,
                planProposal: [
                    {
                        key: 'scan',
                        title: '扫描待办',
                        acceptanceConditionIds: [condition],
                    },
                ],
                replan: {
                    maxReplans: 1,
                    planner: async () => [
                        {
                            key: 'fix',
                            title: '补救扫描',
                            acceptanceConditionIds: [condition],
                        },
                    ],
                },
            },
            [target],
        );

        expect(result.ok).toBe(true);
        expect(result.planRevisions?.[0]?.planVersion).toBe(2);
        expect(await store.loadTask(orphan.taskId)).toBeUndefined();
        // 失败尝试（含 replan 前的扫描失败）与有 Step 的 pending 行都保留。
        expect((await store.loadTask(failedAttempt.taskId))?.status).toBe('failed');
        expect((await store.loadTask(pendingWithStep.taskId))?.status).toBe('pending');
        expect((await store.listSteps(pendingWithStep.taskId))).toHaveLength(1);
        const stored = await store.listTasks(target.goalId);
        expect(stored.map((item) => item.title)).toContain('扫描待办');
        expect(stored.find((item) => item.title === '扫描待办')?.status).toBe('failed');
        expect(stored.find((item) => item.title === '补救扫描')?.planVersion).toBe(2);
    });
});
