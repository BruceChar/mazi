import type { Goal, PermissionLevel } from '@mazi/core';
import { ulid } from '@mazi/core';
import type { TaskOutcome } from '../gts/goal-executor.js';
import type { DelegationStore } from './delegation-store.js';
import type {
    AgentRole,
    DelegationChildResult,
    DelegationEdge,
    DelegationProposal,
    DelegationViolation,
} from './delegation-types.js';
import type { AgentRoleRegistry } from './roles.js';

const LEVEL_RANK: Record<PermissionLevel, number> = {
    text: 0,
    'read-only': 1,
    'workspace-write': 2,
    draft: 3,
    approved: 4,
    autonomous: 5,
};

function strictest(...levels: Array<PermissionLevel | undefined>): PermissionLevel {
    return (
        levels
            .filter((level): level is PermissionLevel => level !== undefined)
            .sort((left, right) => LEVEL_RANK[left] - LEVEL_RANK[right])[0] ?? 'read-only'
    );
}

function budgetCost(budget: DelegationProposal['budget']): number {
    return budget?.maxCostUsd ?? 0;
}

export function validateDelegations(input: {
    parent: Goal;
    proposals: readonly DelegationProposal[];
    roles: AgentRoleRegistry;
    existing: readonly DelegationEdge[];
}): DelegationViolation[] {
    const violations: DelegationViolation[] = [];
    const existingCost = input.existing.reduce(
        (sum, edge) => sum + budgetCost(edge.budgetShare),
        0,
    );
    const proposedCost = input.proposals.reduce(
        (sum, proposal) => sum + budgetCost(proposal.budget),
        0,
    );
    if (
        input.parent.budget.maxCostUsd !== undefined &&
        existingCost + proposedCost > input.parent.budget.maxCostUsd + Number.EPSILON
    ) {
        violations.push({ code: 'budget-overflow', message: '子 Agent 预算之和超过父预算' });
    }
    for (const proposal of input.proposals) {
        const role = input.roles.get(proposal.roleId);
        if (role === undefined) {
            violations.push({
                code: 'unknown-role',
                message: `未知 Agent role：${proposal.roleId}`,
            });
            continue;
        }
        if (
            proposal.ceiling !== undefined &&
            LEVEL_RANK[proposal.ceiling] > LEVEL_RANK[input.parent.permissionCeiling]
        ) {
            violations.push({ code: 'ceiling-raise', message: '子 Agent 权限超过父上限' });
        }
        const ceiling = strictest(
            input.parent.permissionCeiling,
            role.defaultCeiling,
            proposal.ceiling,
        );
        if (LEVEL_RANK[ceiling] > LEVEL_RANK[input.parent.permissionCeiling]) {
            violations.push({ code: 'ceiling-raise', message: '子 Agent 权限超过父上限' });
        }
    }
    return violations;
}

export interface DelegateRunContext {
    rootGoalId: string;
    parentGoal: Goal;
    role: AgentRole;
    proposal: DelegationProposal;
    permissionCeiling: PermissionLevel;
    budget: DelegationProposal['budget'];
}

export type DelegateExecutor = (context: DelegateRunContext) => Promise<{
    childGoalId: string;
    result: {
        ok: boolean;
        tasks: readonly TaskOutcome[];
    };
}>;

export class DelegationCoordinator {
    constructor(
        private readonly roles: AgentRoleRegistry,
        private readonly store: DelegationStore,
        private readonly now: () => number = Date.now,
    ) {}

    async delegate(
        rootGoalId: string,
        parentGoal: Goal,
        proposals: readonly DelegationProposal[],
        execute: DelegateExecutor,
        causedBy: string = parentGoal.goalId,
    ): Promise<{ results: DelegationChildResult[]; violations: DelegationViolation[] }> {
        const existing = await this.store.listByParent(parentGoal.goalId);
        const violations = validateDelegations({
            parent: parentGoal,
            proposals,
            roles: this.roles,
            existing,
        });
        if (violations.length > 0) return { results: [], violations };
        const results = await Promise.all(
            proposals.map(async (proposal) => {
                const role = this.roles.get(proposal.roleId);
                if (role === undefined) {
                    return {
                        roleId: proposal.roleId,
                        childGoalId: '',
                        ok: false,
                        summary: '',
                        error: 'unknown role',
                    };
                }
                const permissionCeiling = strictest(
                    parentGoal.permissionCeiling,
                    role.defaultCeiling,
                    proposal.ceiling,
                );
                try {
                    const child = await execute({
                        rootGoalId,
                        parentGoal,
                        role,
                        proposal,
                        permissionCeiling,
                        budget: proposal.budget,
                    });
                    const last = child.result.tasks.at(-1);
                    const edge: DelegationEdge = {
                        edgeId: ulid(),
                        rootGoalId: rootGoalId as DelegationEdge['rootGoalId'],
                        parentGoalId: parentGoal.goalId,
                        childGoalId: child.childGoalId as DelegationEdge['childGoalId'],
                        roleId: role.roleId,
                        mode: 'model',
                        permissionCeiling,
                        budgetShare: proposal.budget ?? {},
                        causedBy,
                        createdAt: this.now(),
                    };
                    await this.store.save(edge);
                    return {
                        roleId: role.roleId,
                        childGoalId: child.childGoalId,
                        ok: child.result.ok,
                        summary: last?.finalMessage ?? '',
                        ...(child.result.ok
                            ? {}
                            : { error: last?.errorMessage ?? last?.reason ?? 'delegate failed' }),
                    };
                } catch (error) {
                    return {
                        roleId: role.roleId,
                        childGoalId: '',
                        ok: false,
                        summary: '',
                        error: error instanceof Error ? error.message : String(error),
                    };
                }
            }),
        );
        return { results, violations: [] };
    }

    edges(rootGoalId: string): Promise<DelegationEdge[]> {
        return this.store.listByRoot(rootGoalId);
    }
}
