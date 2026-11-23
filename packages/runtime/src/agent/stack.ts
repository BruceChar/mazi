import type { RuntimeConfig } from '../config.js';
import { DelegationCoordinator } from './delegation.js';
import type { DelegationStore } from './delegation-store.js';
import { MemoryDelegationStore, SqliteDelegationStore } from './delegation-store.js';
import type { AgentRole } from './delegation-types.js';
import { MemoryAgentRoleStore, SqliteAgentRoleStore } from './role-store.js';
import { AgentRoleRegistry, defaultAgentRoles } from './roles.js';

/**
 * DelegationStack —— 角色注册表 + 委派记录 + 协调器的组合根。
 *
 * 三者在同一生命周期内成对使用；宿主只持有本栈，按需取 roles/coordinator。
 */
export class DelegationStack {
    readonly roles: AgentRoleRegistry;
    readonly coordinator: DelegationCoordinator;
    private readonly store: DelegationStore;

    constructor(config: RuntimeConfig) {
        this.roles = new AgentRoleRegistry(
            defaultAgentRoles(config.agentPrompts),
            config.dbPath !== undefined
                ? new SqliteAgentRoleStore(config.dbPath)
                : new MemoryAgentRoleStore(),
        );
        this.store =
            config.dbPath !== undefined
                ? new SqliteDelegationStore(config.dbPath)
                : new MemoryDelegationStore();
        this.coordinator = new DelegationCoordinator(this.roles, this.store);
    }

    listRoles(): AgentRole[] {
        return this.roles.list();
    }

    close(): void {
        this.roles.close();
        this.store.close();
    }
}
