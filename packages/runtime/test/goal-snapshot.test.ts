import { describe, expect, it } from 'vitest';
import type { Goal, Step, Task, ULID } from '@mazi/core';
import { ulid } from '@mazi/core';
import { snapshotGoalTree } from '../src/observability/goal-snapshot.js';

const goal = (id: ULID, kind: 'intake' | 'work' = 'work'): Goal => ({
    goalId: id,
    rootGoalId: ulid(),
    origin: kind === 'intake' ? { kind: 'human' } : undefined,
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
        const snap = snapshotGoalTree(
            ulid(),
            [goal(ulid(), 'intake'), goal(ulid()), goal(ulid())],
            [task(ulid(), ulid()), task(ulid(), ulid())],
            [step(ulid(), ulid(), ulid())],
        );
        expect(snap.goals).toHaveLength(3);
        expect(snap.taskCount).toBe(2);
        expect(snap.stepCount).toBe(1);
        const goalA = snap.goals.find((g: Goal) => g.goalId === ulid());
        expect(goalA?.tasks[0]?.taskId).toBe(ulid());
        expect(goalA?.tasks[0]?.steps[0]?.goalId).toBe(ulid());
        expect(snap.goals[0]?.kind).toBe('intake');
    });
});
