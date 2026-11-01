import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    AgentRoleRegistry,
    DEFAULT_AGENT_ROLES,
    SqliteAgentRoleStore,
} from '../src/agent/index.js';

function registry(dbPath: string): AgentRoleRegistry {
    return new AgentRoleRegistry(DEFAULT_AGENT_ROLES, new SqliteAgentRoleStore(dbPath));
}

describe('AgentRole persistence', () => {
    it('restores custom roles and persisted removals', () => {
        const dbPath = join(mkdtempSync(join(tmpdir(), 'mazi-role-store-')), 'mazi.db');
        const first = registry(dbPath);
        first.register({
            roleId: 'tester',
            label: '测试 Agent',
            tools: ['fs.read', 'rg'],
            defaultCeiling: 'read-only',
            memoryPolicy: 'inherit',
        });
        first.remove('researcher');
        first.close();

        const second = registry(dbPath);
        expect(second.get('tester')).toMatchObject({ label: '测试 Agent' });
        expect(second.get('researcher')).toBeUndefined();
        second.close();
    });
});
