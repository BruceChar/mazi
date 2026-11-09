import { type AgentPromptOverrides, resolveAgentPrompt } from '../prompts/agent-prompts.js';
import type { AgentRole } from './delegation-types.js';
import type { AgentRoleStore, PersistedAgentRole } from './role-store.js';

/**
 * 内置委派角色。系统提示统一取自 Agent 提示注册表（prompts.<roleId>），
 * config 覆盖优先、内置默认兜底。
 */
export function defaultAgentRoles(overrides?: AgentPromptOverrides): AgentRole[] {
    return [
        {
            roleId: 'default',
            label: '默认 Agent',
            tools: ['fs.read', 'rg', 'fd'],
            systemPrompt: resolveAgentPrompt('default', overrides),
            defaultCeiling: 'read-only',
            memoryPolicy: 'inherit',
        },
        {
            roleId: 'coding',
            label: '编码 Agent',
            tools: ['fs.read', 'rg', 'sd', 'shell.run', 'git'],
            systemPrompt: resolveAgentPrompt('coding', overrides),
            defaultCeiling: 'workspace-write',
            memoryPolicy: 'inherit',
        },
        {
            roleId: 'planner',
            label: '规划 Agent',
            tools: ['fs.read', 'rg', 'fd'],
            systemPrompt: resolveAgentPrompt('planner', overrides),
            defaultCeiling: 'read-only',
            memoryPolicy: 'inherit',
        },
        {
            roleId: 'executor',
            label: '执行 Agent',
            tools: ['fs.read', 'rg', 'sd', 'shell.run', 'git'],
            systemPrompt: resolveAgentPrompt('executor', overrides),
            defaultCeiling: 'workspace-write',
            memoryPolicy: 'inherit',
        },
        {
            roleId: 'reviewer',
            label: '审查 Agent',
            tools: ['fs.read', 'rg', 'git'],
            systemPrompt: resolveAgentPrompt('reviewer', overrides),
            defaultCeiling: 'read-only',
            memoryPolicy: 'inherit',
        },
        {
            roleId: 'researcher',
            label: '研究 Agent',
            tools: ['fs.read', 'rg', 'fd', 'xh'],
            systemPrompt: resolveAgentPrompt('researcher', overrides),
            defaultCeiling: 'draft',
            memoryPolicy: 'inherit',
        },
    ];
}

export const DEFAULT_AGENT_ROLES: readonly AgentRole[] = defaultAgentRoles();

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
