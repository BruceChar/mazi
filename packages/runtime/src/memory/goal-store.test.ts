import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Goal, Step, Task } from '../../../core/src/goal-coordinate.js';
import { MemoryGoalStore, SqliteGoalStore } from './goal-store.js';

function goal(id: string, root = id): Goal {
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
function task(id: string, goalId: string): Task {
    return { taskId: id, goalId, title: 't', acceptance: { conditions: [] }, status: 'pending' };
}
function step(id: string, taskId: string, goalId: string): Step {
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
        it(`round-trip + 按 root/goal/task 投影（${make().constructor.name}）`, async () => {
            const store = make();
            try {
                const root = goal('root');
                const child = goal('w', 'root');
                await store.saveGoal(root);
                await store.saveGoal(child);
                expect((await store.listGoalsByRoot('root')).map((g) => g.goalId).sort()).toEqual([
                    'root',
                    'w',
                ]);
                expect((await store.loadGoal('w'))?.rootGoalId).toBe('root');

                const t1 = task('t1', 'w');
                await store.saveTask(t1);
                expect((await store.listTasks('w'))[0]?.taskId).toBe('t1');

                const s1 = step('s1', 't1', 'w');
                await store.saveStep(s1);
                expect((await store.loadStep('s1'))?.goalId).toBe('w');
                expect((await store.listSteps('t1'))[0]?.stepId).toBe('s1');
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
        const a = new SqliteGoalStore(file);
        await a.saveGoal(goal('persist'));
        a.close();
        const b = new SqliteGoalStore(file);
        expect((await b.loadGoal('persist'))?.goalId).toBe('persist');
        b.close();
    });
});
