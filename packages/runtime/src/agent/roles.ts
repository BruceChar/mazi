import type { AgentRole } from './delegation-types.js';
import type { AgentRoleStore, PersistedAgentRole } from './role-store.js';

export const DEFAULT_AGENT_ROLES: readonly AgentRole[] = [
    {
        roleId: 'planner',
        label: '规划 Agent',
        tools: ['fs.read', 'rg', 'fd'],
        systemPrompt: '你负责把目标拆成可验证的 Task，不直接执行高风险动作。',
        defaultCeiling: 'read-only',
        memoryPolicy: 'inherit',
    },
    {
        roleId: 'executor',
        label: '执行 Agent',
        tools: ['fs.read', 'rg', 'sd', 'shell.run', 'git'],
        systemPrompt: '你负责执行已分配的 Task，并报告真实工具结果和验证状态。',
        defaultCeiling: 'workspace-write',
        memoryPolicy: 'inherit',
    },
    {
        roleId: 'reviewer',
        label: '审查 Agent',
        tools: ['fs.read', 'rg', 'git'],
        systemPrompt: '你独立审查结果，优先报告缺陷、风险和未验证项，不修改实现。',
        defaultCeiling: 'read-only',
        memoryPolicy: 'inherit',
    },
    {
        roleId: 'researcher',
        label: '研究 Agent',
        tools: ['fs.read', 'rg', 'fd', 'xh'],
        systemPrompt: '你负责调查和证据归纳，区分事实、来源和推断。',
        defaultCeiling: 'draft',
        memoryPolicy: 'inherit',
    },
];

export class AgentRoleRegistry {
    private readonly roles = new Map<string, PersistedAgentRole>();

    constructor(
        initial: readonly AgentRole[] = DEFAULT_AGENT_ROLES,
        private readonly store?: AgentRoleStore,
    ) {
        for (const role of initial) this.storeRole({ role, deleted: false });
        for (const entry of store?.load() ?? []) this.storeRole(entry);
    }

    register(role: AgentRole): void {
        this.assertRole(role);
        const entry = { role: structuredClone(role), deleted: false } satisfies PersistedAgentRole;
        this.store?.save(entry);
        this.storeRole(entry);
    }

    remove(roleId: string): boolean {
        const existing = this.roles.get(roleId);
        if (existing === undefined || existing.deleted) return false;
        const entry = { role: existing.role, deleted: true } satisfies PersistedAgentRole;
        this.storeRole(entry);
        this.store?.save(structuredClone(entry));
        return true;
    }

    get(roleId: string): AgentRole | undefined {
        const entry = this.roles.get(roleId);
        return entry === undefined || entry.deleted ? undefined : structuredClone(entry.role);
    }

    list(): AgentRole[] {
        return [...this.roles.values()]
            .filter((entry) => !entry.deleted)
            .map((entry) => entry.role)
            .sort((left, right) => left.roleId.localeCompare(right.roleId))
            .map((role) => structuredClone(role));
    }

    close(): void {
        this.store?.close();
    }

    private assertRole(role: AgentRole): void {
        if (role.roleId.trim().length === 0) throw new Error('roleId 必填');
    }

    private storeRole(entry: PersistedAgentRole): void {
        this.assertRole(entry.role);
        this.roles.set(entry.role.roleId, structuredClone(entry));
    }
}
