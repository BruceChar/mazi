import type { AgentRole } from './delegation-types.js';

export const DEFAULT_AGENT_ROLES: readonly AgentRole[] = [
    {
        roleId: 'planner',
        label: '规划 Agent',
        tools: ['fs.read', 'rg', 'fd', 'blackboard.read'],
        systemPrompt: '你负责把目标拆成可验证的 Task，不直接执行高风险动作。',
        defaultCeiling: 'read-only',
        memoryPolicy: 'inherit',
    },
    {
        roleId: 'executor',
        label: '执行 Agent',
        tools: ['fs.read', 'rg', 'sd', 'shell.run', 'git', 'blackboard.read'],
        systemPrompt: '你负责执行已分配的 Task，并报告真实工具结果和验证状态。',
        defaultCeiling: 'workspace-write',
        memoryPolicy: 'inherit',
    },
    {
        roleId: 'reviewer',
        label: '审查 Agent',
        tools: ['fs.read', 'rg', 'git', 'blackboard.read'],
        systemPrompt: '你独立审查结果，优先报告缺陷、风险和未验证项，不修改实现。',
        defaultCeiling: 'read-only',
        memoryPolicy: 'inherit',
    },
    {
        roleId: 'researcher',
        label: '研究 Agent',
        tools: ['fs.read', 'rg', 'fd', 'xh', 'blackboard.read'],
        systemPrompt: '你负责调查和证据归纳，区分事实、来源和推断。',
        defaultCeiling: 'draft',
        memoryPolicy: 'inherit',
    },
];

export class AgentRoleRegistry {
    private readonly roles = new Map<string, AgentRole>();

    constructor(initial: readonly AgentRole[] = DEFAULT_AGENT_ROLES) {
        for (const role of initial) this.register(role);
    }

    register(role: AgentRole): void {
        if (role.roleId.trim().length === 0) throw new Error('roleId 必填');
        this.roles.set(role.roleId, structuredClone(role));
    }

    remove(roleId: string): boolean {
        return this.roles.delete(roleId);
    }

    get(roleId: string): AgentRole | undefined {
        return structuredClone(this.roles.get(roleId));
    }

    list(): AgentRole[] {
        return [...this.roles.values()]
            .sort((left, right) => left.roleId.localeCompare(right.roleId))
            .map((role) => structuredClone(role));
    }
}
