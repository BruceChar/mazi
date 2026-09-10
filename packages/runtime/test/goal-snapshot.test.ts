import { describe, expect, it } from 'vitest';
import type { Goal, Step, Task, ULID } from '@mazi/core';
import { ulid } from '@mazi/core';
import { snapshotGoalTree } from '../src/observability/goal-snapshot.js';

const goal = (id: ULID, kind: 'intake' | 'work' = 'work', rootId: ULID = id): Goal => ({
    goalId: id,
    rootGoalId: rootId,
    origin: { kind: 'human' },
    kind,
    statement: `s-${id}`,
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
});
const task = (id: ULID, goalId: ULID): Task => ({
    taskId: id,
    goalId,
    title: `t-${id}`,
    acceptance: { conditions: [] },
    status: 'pending',
});
const step = (id: ULID, taskId: ULID, goalId: ULID): Step => ({
    stepId: id,
    taskId,
    goalId,
    kind: 'thinking',
    payload: { content: 'x' },
    status: 'ok',
    startedAt: 1,
});

describe('goal-snapshot（C3f：四元组层级投影）', () => {
    it('intake+work → 树视图含 tasks/steps 计数', () => {
        const root = ulid();
        const intake = goal(root, 'intake', root);
        const workA = goal(ulid(), 'work', root);
        const workB = goal(ulid(), 'work', root);
        const t1 = task(ulid(), workA.goalId);
        const t2 = task(ulid(), workB.goalId);
        const s1 = step(ulid(), t1.taskId, workA.goalId);
        const snap = snapshotGoalTree(root, [intake, workA, workB], [t1, t2], [s1]);
        expect(snap.goals).toHaveLength(3);
        expect(snap.taskCount).toBe(2);
        expect(snap.stepCount).toBe(1);
        expect(snap.goals[0]?.kind).toBe('intake');
        const nodeA = snap.goals.find((g) => g.goalId === workA.goalId);
        expect(nodeA?.tasks[0]?.taskId).toBe(t1.taskId);
        expect(nodeA?.tasks[0]?.steps[0]?.stepId).toBe(s1.stepId);
    });
});
