import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Goal, Step, Task, ULID } from '@mazi/core';
import { ulid } from '@mazi/core';
import { MemoryGoalStore, SqliteGoalStore } from '../src/memory/goal-store.js';

function goal(id: ULID, root = id): Goal {
    return {
        goalId: id,
        rootGoalId: root,
        origin: { kind: 'human' },
        kind: id === root ? 'intake' : 'work',
        statement: 's',
        contract: {
            successConditions: [],
            failureConditions: [],
            forbiddenResources: [],
            budget: {},
            terminationPolicy: {},
            riskProfile: {
                hasIrreversibleActions: false,
                touchesNetwork: false,
                touchesExternalApi: false,
            },
        },
        permissionCeiling: 'read-only',
        budget: {},
        status: 'active',
        createdAt: 1,
    };
}
function task(id: ULID, goalId: ULID): Task {
    return { taskId: id, goalId, title: 't', acceptance: { conditions: [] }, status: 'pending' };
}
function step(id: ULID, taskId: ULID, goalId: ULID): Step {
    return {
        stepId: id,
        taskId,
        goalId,
        kind: 'thinking',
        payload: { content: 'x' },
        status: 'ok',
        startedAt: 1,
    };
}

describe('GoalStore（并存存储，C3a）', () => {
    for (const make of [() => new MemoryGoalStore(), () => new SqliteGoalStore(':memory:')]) {
        it(`deleteGoalTree 级联删除 goals/tasks/steps（${make().constructor.name}）`, async () => {
            const store = make();
            try {
                const root = goal(ulid());
                const child = goal(ulid(), root.goalId);
                const other = goal(ulid());
                await store.saveGoal(root);
                await store.saveGoal(child);
                await store.saveGoal(other);
                const task1 = task(ulid(), child.goalId);
                const task2 = task(ulid(), other.goalId);
                await store.saveTask(task1);
                await store.saveTask(task2);
                const s1 = step(ulid(), task1.taskId, child.goalId);
                const s2 = step(ulid(), task2.taskId, other.goalId);
                await store.saveStep(s1);
                await store.saveStep(s2);
                await store.deleteGoalTree(root.goalId);
                expect(await store.listGoalsByRoot(root.goalId)).toEqual([]);
                expect((await store.loadGoal(other.goalId))?.goalId).toBe(other.goalId);
                expect(await store.listTasks(child.goalId)).toEqual([]);
                expect(await store.listSteps(task1.taskId)).toEqual([]);
                expect(await store.loadStep(s1.stepId)).toBeUndefined();
                expect((await store.loadStep(s2.stepId))?.stepId).toBe(s2.stepId);
            } finally {
                store.close();
            }
        });

        it(`round-trip + 按 root/goal/task 投影（${make().constructor.name}）`, async () => {
            const store = make();
            try {
                const root = goal(ulid());
                const child = goal(ulid(), root.goalId);
                await store.saveGoal(root);
                await store.saveGoal(child);
                expect((await store.listGoalsByRoot(root.goalId)).map((g) => g.goalId).sort()).toEqual([
                    root.goalId,
                    child.goalId,
                ]);
                expect((await store.loadGoal(child.goalId))?.rootGoalId).toBe(root.goalId);

                const t1 = task(ulid(), child.goalId);
                await store.saveTask(t1);
                expect((await store.listTasks(child.goalId))[0]?.taskId).toBe(t1.taskId);

                const s1 = step(ulid(), t1.taskId, child.goalId);
                await store.saveStep(s1);
                expect((await store.loadStep(s1.stepId))?.goalId).toBe(child.goalId);
                expect((await store.listSteps(t1.taskId))[0]?.stepId).toBe(s1.stepId);
            } finally {
                store.close();
            }
        });
    }
});

describe('SqliteGoalStore 文件持久化', () => {
    let dir: string;
    let file: string;
    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'mazi-gs-'));
        file = join(dir, 'goals.db');
    });
    afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('重开连接后数据可读', async () => {
        const g = goal(ulid());
        const a = new SqliteGoalStore(file);
        await a.saveGoal(g);
        a.close();
        const b = new SqliteGoalStore(file);
        expect((await b.loadGoal(g.goalId))?.goalId).toBe(g.goalId);
        b.close();
    });
});
