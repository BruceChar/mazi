import { describe, expect, it } from 'vitest';
import type { Goal, Step, Task } from '../../../core/src/goal-coordinate.js';
import { snapshotGoalTree } from './goal-snapshot.js';

const goal = (id: string, kind: 'intake' | 'work' = 'work'): Goal => ({
    goalId: id,
    rootGoalId: 'root',
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
const task = (id: string, goalId: string): Task => ({
    taskId: id,
    goalId,
    title: `t-${id}`,
    acceptance: { conditions: [] },
    status: 'pending',
});
const step = (id: string, taskId: string, goalId: string): Step => ({
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
            'root',
            [goal('root', 'intake'), goal('a'), goal('b')],
            [task('t1', 'a'), task('t2', 'b')],
            [step('s1', 't1', 'a')],
        );
        expect(snap.goals).toHaveLength(3);
        expect(snap.taskCount).toBe(2);
        expect(snap.stepCount).toBe(1);
        const goalA = snap.goals.find((g) => g.goalId === 'a');
        expect(goalA?.tasks[0]?.taskId).toBe('t1');
        expect(goalA?.tasks[0]?.steps[0]?.goalId).toBe('a');
        expect(snap.goals[0]?.kind).toBe('intake');
    });
});
