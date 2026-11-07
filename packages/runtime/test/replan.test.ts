import type { Goal } from '@mazi/core';
import { describe, expect, it } from 'vitest';
import {
    buildReplanPlannerPrompt,
    createLlmReplanPlanner,
    createPlanRevision,
} from '../src/gts/replan.js';

function goal(): Goal {
  return {
    goalId: 'g1',
    statement: '完成任务',
    contract: {
      successConditions: [
        { id: 'c1', checkType: 'deterministic', check: { kind: 'final-answer' } },
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

describe('createPlanRevision', () => {
  it('retains completed tasks and creates a bounded new plan', async () => {
    const result = await createPlanRevision({
      request: {
        goal: goal(),
        revision: 0,
        completedTasks: [
          {
            taskId: 'done',
            goalId: 'g1',
            title: '已完成',
            acceptance: { conditions: ['c1'] },
            status: 'succeeded',
          },
        ],
        failedTask: {
          taskId: 'failed',
          goalId: 'g1',
          title: '失败任务',
          acceptance: { conditions: ['c1'] },
          status: 'failed',
        },
        failureReason: 'failed',
        evidence: ['tool failed'],
        remainingBudget: { maxCostUsd: 5 },
      },
      proposal: [
        {
          key: 'retry',
          title: '改用替代方案',
          acceptanceConditionIds: ['c1'],
          budget: { maxCostUsd: 2 },
        },
      ],
      priorDigests: [],
      now: () => 42,
    });
    expect(result.revision).toMatchObject({
      revision: 1,
      reason: 'verifier:failed',
      createdAt: 42,
    });
    expect(result.revision?.tasks.map((task) => task.title)).toEqual([
      '已完成',
      '改用替代方案',
    ]);
    expect(result.revision?.diff).toMatchObject({
      added: ['改用替代方案'],
      removed: ['失败任务'],
      retained: ['已完成'],
    });
  });

  it('rejects repeated plans, budget overflow and permission escalation', async () => {
    const base = {
      goal: goal(),
      revision: 0,
      completedTasks: [],
      failedTask: {
        taskId: 'failed',
        goalId: 'g1',
        title: '失败任务',
        acceptance: { conditions: ['c1'] },
        status: 'failed' as const,
      },
      failureReason: 'failed',
      evidence: [],
      remainingBudget: { maxCostUsd: 1 },
    };
    const first = await createPlanRevision({
      request: base,
      proposal: [{ key: 'x', title: 'X', acceptanceConditionIds: ['c1'] }],
    });
    expect(first.revision).toBeDefined();
    const repeated = await createPlanRevision({
      request: base,
      proposal: [{ key: 'x', title: 'X', acceptanceConditionIds: ['c1'] }],
      priorDigests: [first.revision!.digest],
    });
    expect(repeated.rejected).toContain('Replan 产生重复计划');

    const invalid = await createPlanRevision({
      request: base,
      proposal: [
        {
          key: 'bad',
          title: 'Bad',
          acceptanceConditionIds: ['c1'],
          permissionCeiling: 'autonomous',
          budget: { maxCostUsd: 5 },
        },
      ],
    });
    expect(invalid.rejected?.join('\n')).toContain('权限超过 Goal 上限');
    expect(invalid.rejected?.join('\n')).toContain('预算超过剩余预算');
  });
});

describe('replan planner prompt / factory', () => {
  it('prompt 包含失败原因、已完成 Task 与剩余预算', () => {
    const prompt = buildReplanPlannerPrompt({
      goal: goal(),
      revision: 0,
      completedTasks: [
        {
          taskId: 'done',
          goalId: 'g1',
          title: '已完成',
          acceptance: { conditions: ['c1'] },
          status: 'succeeded',
        },
      ],
      failedTask: {
        taskId: 'failed',
        goalId: 'g1',
        title: '失败任务',
        acceptance: { conditions: ['c1'] },
        status: 'failed',
      },
      failureReason: 'failed',
      evidence: ['tool failed: exit code 1'],
      remainingBudget: { maxCostUsd: 5 },
    });
    expect(prompt).toContain('Replan Planner');
    expect(prompt).toContain('失败任务');
    expect(prompt).toContain('已完成');
    expect(prompt).toContain('tool failed');
    expect(prompt).toContain('剩余预算');
  });

  it('LLM replan 输出合法 JSON 时解析为 PlannedTask[]，非法时返回 undefined', async () => {
    const planner = createLlmReplanPlanner(async (prompt) => {
      expect(prompt).toContain('Replan Planner');
      return JSON.stringify({
        tasks: [{ key: 'retry', title: '改用替代方案', dependsOn: [], requiredTools: [] }],
      });
    });
    await expect(
      planner({
        goal: goal(),
        revision: 0,
        completedTasks: [],
        failedTask: {
          taskId: 'failed',
          goalId: 'g1',
          title: '失败任务',
          acceptance: { conditions: ['c1'] },
          status: 'failed',
        },
        failureReason: 'failed',
        evidence: [],
        remainingBudget: { maxCostUsd: 5 },
      }),
    ).resolves.toMatchObject([{ key: 'retry', title: '改用替代方案' }]);

    const invalid = createLlmReplanPlanner(async () => '不是 JSON');
    await expect(
      invalid({
        goal: goal(),
        revision: 0,
        completedTasks: [],
        failedTask: {
          taskId: 'failed',
          goalId: 'g1',
          title: '失败任务',
          acceptance: { conditions: ['c1'] },
          status: 'failed',
        },
        failureReason: 'failed',
        evidence: [],
        remainingBudget: { maxCostUsd: 5 },
      }),
    ).resolves.toBeUndefined();
  });
});
