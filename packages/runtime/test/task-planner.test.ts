import type { Goal } from '@mazi/core';
import { describe, expect, it } from 'vitest';
import {
    allocateTaskBudgets,
    buildTaskPlannerPrompt,
    parseTaskPlan,
} from '../src/gts/task-planner.js';
import { DEFAULT_GOAL_MAX_STEPS, type PlanTool } from '../src/gts/plan-graph.js';

const goal: Goal = {
    goalId: 'goal-1' as Goal['goalId'],
    statement: '分析项目并给出风险和下一步',
    contract: {
        successConditions: [
            {
                id: 'answer' as Goal['contract']['successConditions'][number]['id'],
                checkType: 'semantic',
                description: '回答覆盖项目结构、风险和下一步',
            },
        ],
        failureConditions: [],
        forbiddenResources: [],
        budget: { maxCostUsd: 0.6 },
        terminationPolicy: { maxSteps: 6 },
        riskProfile: {
            hasIrreversibleActions: false,
            touchesNetwork: false,
            touchesExternalApi: false,
        },
    },
    permissionCeiling: 'workspace-write',
    budget: { maxCostUsd: 0.6, maxSteps: 6 },
    status: 'active',
    createdAt: 1,
};

describe('task-planner', () => {
    it('解析有依赖的 Task DAG，并绑定 Goal 验收条件', () => {
        const proposals = parseTaskPlan(
            JSON.stringify({
                tasks: [
                    {
                        key: 'inspect',
                        title: '检查项目结构和关键入口',
                        dependsOn: [],
                        requiredTools: ['rg', 'fs.read'],
                    },
                    {
                        key: 'summarize',
                        title: '归纳风险与下一步',
                        dependsOn: ['inspect'],
                    },
                ],
            }),
            goal,
        );
        expect(proposals?.map((item) => item.key)).toEqual(['inspect', 'summarize']);
        expect(proposals?.[1]?.dependsOn).toEqual(['inspect']);
        expect(proposals?.[0]?.acceptanceConditionIds).toEqual(['answer']);
    });

    it('重复 key、未知依赖、非法标题和空计划均拒绝', () => {
        const raw = (tasks: unknown[]) => JSON.stringify({ tasks });
        expect(parseTaskPlan(raw([{ key: 'a', title: 'A' }, { key: 'a', title: 'B' }]), goal)).toBeUndefined();
        expect(
            parseTaskPlan(raw([{ key: 'a', title: 'A', dependsOn: ['missing'] }]), goal),
        ).toBeUndefined();
        expect(parseTaskPlan(raw([{ key: 'a', title: '' }]), goal)).toBeUndefined();
        expect(parseTaskPlan(raw([]), goal)).toBeUndefined();
        expect(
            parseTaskPlan(raw([{ key: 'a', title: 'A', dependsOn: 'other' }]), goal),
        ).toBeUndefined();
        expect(
            parseTaskPlan(raw([{ key: 'a', title: 'A', requiredTools: 'rg' }]), goal),
        ).toBeUndefined();
        expect(
            parseTaskPlan(
                raw([
                    { key: 'a', title: 'A' },
                    { key: 'b', title: 'B' },
                ]),
                goal,
                1,
            ),
        ).toBeUndefined();
    });

    it('预算按 Task 数量分摊，steps 总和不超过 Goal 上限', () => {
        const proposals = parseTaskPlan(
            JSON.stringify({
                tasks: [
                    { key: 'a', title: 'A' },
                    { key: 'b', title: 'B' },
                    { key: 'c', title: 'C' },
                ],
            }),
            goal,
        );
        const allocated = allocateTaskBudgets(goal, proposals ?? []);
        expect(allocated.map((item) => item.budget?.maxSteps)).toEqual([2, 2, 2]);
        expect(
            allocated.reduce((sum, item) => sum + (item.budget?.maxCostUsd ?? 0), 0),
        ).toBeCloseTo(0.6);
    });

    it('未显式配置轮次时仍按执行器默认总包络分摊', () => {
        const unconstrained: Goal = {
            ...goal,
            contract: {
                ...goal.contract,
                budget: {},
                terminationPolicy: {},
            },
            budget: {},
        };
        const proposals = parseTaskPlan(
            JSON.stringify({
                tasks: [
                    { key: 'a', title: 'A' },
                    { key: 'b', title: 'B' },
                ],
            }),
            unconstrained,
        );
        const allocated = allocateTaskBudgets(unconstrained, proposals ?? []);
        expect(allocated.map((item) => item.budget?.maxSteps)).toEqual([25, 25]);
        expect(
            allocated.reduce((sum, item) => sum + (item.budget?.maxSteps ?? 0), 0),
        ).toBe(DEFAULT_GOAL_MAX_STEPS);
    });

    it('多个契约预算字段同时存在时使用更严格的上限', () => {
        const constrained: Goal = {
            ...goal,
            contract: {
                ...goal.contract,
                budget: { maxCostUsd: 0.4, maxSteps: 4 },
                terminationPolicy: { maxCostUsd: 0.8, maxSteps: 8 },
            },
            budget: { maxCostUsd: 1, maxSteps: 12 },
        };
        const proposals = parseTaskPlan(
            JSON.stringify({
                tasks: [
                    { key: 'a', title: 'A' },
                    { key: 'b', title: 'B' },
                ],
            }),
            constrained,
        );
        const allocated = allocateTaskBudgets(constrained, proposals ?? []);
        expect(allocated.map((item) => item.budget?.maxSteps)).toEqual([2, 2]);
        expect(
            allocated.reduce((sum, item) => sum + (item.budget?.maxCostUsd ?? 0), 0),
        ).toBeCloseTo(0.4);
    });

    it('planner prompt 只暴露可用工具和 Goal 条件', () => {
        const tools: PlanTool[] = [
            { name: 'fs.read', minPermission: 'read-only' },
            { name: 'shell.run', minPermission: 'draft' },
        ];
        const prompt = buildTaskPlannerPrompt({ goal, availableTools: tools });
        expect(prompt).toContain('Task Planner');
        expect(prompt).toContain('fs.read(read-only)');
        expect(prompt).toContain('回答覆盖项目结构、风险和下一步');
        expect(prompt).toContain('1-6');
    });
});
