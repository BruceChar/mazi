import type { Goal } from '@mazi/core';
import { describe, expect, it } from 'vitest';
import {
    AgentRoleRegistry,
    DelegationCoordinator,
    MemoryDelegationStore,
    validateDelegations,
} from '../src/agent/index.js';

function goal(): Goal {
    return {
        goalId: 'parent',
        statement: '并行研究并审查',
        contract: {
            successConditions: [],
            failureConditions: [],
            forbiddenResources: [],
            budget: { maxCostUsd: 10 },
            terminationPolicy: {},
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

describe('multi-agent delegation', () => {
    it('validates roles, ceilings and total child budgets', () => {
        const roles = new AgentRoleRegistry();
        const parent = goal();
        expect(
            validateDelegations({
                parent,
                roles,
                existing: [],
                proposals: [
                    {
                        statement: '研究',
                        roleId: 'researcher',
                        ceiling: 'workspace-write',
                        budget: { maxCostUsd: 4 },
                    },
                    {
                        statement: '审查',
                        roleId: 'reviewer',
                        ceiling: 'approved',
                        budget: { maxCostUsd: 7 },
                    },
                ],
            }),
        ).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ code: 'ceiling-raise' }),
                expect.objectContaining({ code: 'budget-overflow' }),
            ]),
        );
    });

    it('runs delegate fanout and persists child edges', async () => {
        const roles = new AgentRoleRegistry();
        const store = new MemoryDelegationStore();
        const coordinator = new DelegationCoordinator(roles, store, () => 100);
        const result = await coordinator.delegate(
            'parent',
            goal(),
            [
                { statement: '研究 A', roleId: 'researcher', budget: { maxCostUsd: 2 } },
                { statement: '审查 B', roleId: 'reviewer', budget: { maxCostUsd: 1 } },
            ],
            async ({ proposal, role }) => ({
                childGoalId: `child-${role.roleId}`,
                result: {
                    ok: true,
                    tasks: [
                        {
                            task: {
                                taskId: `task-${role.roleId}`,
                                goalId: `child-${role.roleId}`,
                                title: proposal.statement,
                                acceptance: { conditions: [] },
                                status: 'succeeded',
                            },
                            steps: [],
                            ok: true,
                            reason: 'final-answer',
                            finalMessage: `${role.label}完成`,
                        },
                    ],
                },
            }),
        );
        expect(result.violations).toEqual([]);
        expect(result.results.map((item) => item.ok)).toEqual([true, true]);
        expect(await coordinator.edges('parent')).toHaveLength(2);
    });
});
