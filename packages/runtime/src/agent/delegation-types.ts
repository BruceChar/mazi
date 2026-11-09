import type { BudgetAllocation, PermissionLevel, ULID } from '@mazi/core';

export interface AgentRole {
    roleId: string;
    label: string;
    /** 面向用户的能力说明，同时作为 SuperAgent 自动路由的匹配依据。 */
    description?: string;
    modelId?: string;
    tools?: readonly string[];
    systemPrompt?: string;
    defaultCeiling?: PermissionLevel;
    memoryPolicy?: 'inherit' | 'isolated';
}

export interface DelegationProposal {
    statement: string;
    roleId: string;
    ceiling?: PermissionLevel;
    budget?: BudgetAllocation;
}

export interface DelegationEdge {
    edgeId: string;
    rootGoalId: ULID;
    parentGoalId: ULID;
    childGoalId: ULID;
    roleId: string;
    mode: 'rule' | 'model';
    permissionCeiling: PermissionLevel;
    budgetShare: BudgetAllocation;
    causedBy: string;
    createdAt: number;
}

export interface DelegationViolation {
    code: 'unknown-role' | 'ceiling-raise' | 'budget-overflow' | 'duplicate-child' | 'cycle';
    message: string;
}

export interface DelegationChildResult {
    roleId: string;
    childGoalId: string;
    ok: boolean;
    summary: string;
    error?: string;
}
