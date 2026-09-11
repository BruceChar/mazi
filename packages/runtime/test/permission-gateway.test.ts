import { describe, expect, it } from 'vitest';

import type { authz } from '@mazi/core';

import type { ToolCallResult, ToolConfig } from '../src/config.js';
import {
    capabilityForTool,
    grantForPermissionLevel,
    RuntimeToolGateway,
} from '../src/tool-gateway/permission.js';

function tool(partial: Partial<ToolConfig> & Pick<ToolConfig, 'name' | 'minPermission'>): ToolConfig {
    return {
        description: partial.name,
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
        sideEffects: [],
        ...partial,
    };
}

const TOOLS: ToolConfig[] = [
    tool({ name: 'fs.read', minPermission: 'read-only' }),
    tool({ name: 'rg', minPermission: 'read-only' }),
    tool({
        name: 'sd',
        minPermission: 'draft',
        irreversible: true,
        sideEffects: ['fs'],
        command: { bin: 'sd', args: [] },
    }),
    tool({
        name: 'xh',
        minPermission: 'draft',
        sideEffects: ['net'],
        command: { bin: 'xh', args: [] },
    }),
    tool({
        name: 'shell.run',
        minPermission: 'draft',
        irreversible: true,
        sideEffects: ['fs', 'net'],
    }),
];

const execute = async (config: ToolConfig): Promise<ToolCallResult> => ({
    ok: true,
    content: `ran:${config.name}`,
});

describe('runtime permission bridge', () => {
    it('maps permission levels to capability grants', () => {
        expect(grantForPermissionLevel('text')).toEqual({});
        expect(Object.keys(grantForPermissionLevel('read-only'))).toEqual(['fs.read.workspace']);
        expect(Object.keys(grantForPermissionLevel('draft'))).toContain('fs.exec');
        expect(Object.keys(grantForPermissionLevel('draft'))).not.toContain('net.send');
        expect(Object.keys(grantForPermissionLevel('approved'))).toContain('net.send');
    });

    it('derives the dispatch capability from the tool shape', () => {
        expect(capabilityForTool(TOOLS[0])).toBe('fs.read.workspace');
        expect(capabilityForTool(TOOLS[2])).toBe('fs.write.workspace');
        expect(capabilityForTool(TOOLS[3])).toBe('net.fetch');
        expect(capabilityForTool(TOOLS[4])).toBe('fs.exec');
    });

    it('narrows the supply view to the ceiling', () => {
        const readOnly = new RuntimeToolGateway({
            rootGoalId: 'r',
            goalId: 'g',
            taskId: 't',
            level: 'read-only',
            tools: TOOLS,
            execute,
        });
        expect(readOnly.visibleToolNames().sort()).toEqual(['fs.read', 'rg']);

        const draft = new RuntimeToolGateway({
            rootGoalId: 'r',
            goalId: 'g',
            taskId: 't',
            level: 'draft',
            tools: TOOLS,
            execute,
        });
        expect(draft.visibleToolNames().sort()).toEqual(['fs.read', 'rg', 'sd', 'shell.run', 'xh']);
    });

    it('rejects tools outside the ceiling (supply narrowing is enforced)', async () => {
        const gateway = new RuntimeToolGateway({
            rootGoalId: 'r',
            goalId: 'g',
            taskId: 't',
            level: 'read-only',
            tools: TOOLS,
            execute,
        });
        const result = await gateway.invoke('shell.run', { command: 'echo hi' });
        expect(result.ok).toBe(false);
        expect(result.error).toContain('工具被策略拦截');
    });

    it('executes a read tool and a draft tool through the pipeline', async () => {
        const gateway = new RuntimeToolGateway({
            rootGoalId: 'r',
            goalId: 'g',
            taskId: 't',
            level: 'draft',
            tools: TOOLS,
            execute,
        });
        expect(await gateway.invoke('rg', { pattern: 'x' })).toMatchObject({ ok: true });
        expect(await gateway.invoke('shell.run', { command: 'echo hi' })).toMatchObject({
            ok: true,
            content: 'ran:shell.run',
        });
        expect(await gateway.invoke('xh', { url: 'https://example.com' })).toMatchObject({
            ok: true,
        });
    });

    it('emits gateway stage audit events', async () => {
        const events: authz.GatewayAuditEvent[] = [];
        const gateway = new RuntimeToolGateway({
            rootGoalId: 'r',
            goalId: 'g',
            taskId: 't',
            level: 'draft',
            tools: TOOLS,
            execute,
            audit: { log: (event) => events.push(event) },
        });
        await gateway.invoke('rg', { pattern: 'x' }, { stepId: 's-1' });
        expect(events.map((e) => e.stage)).toContain('tier-dispatch');
        expect(events.some((e) => e.identifiers.stepId === 's-1')).toBe(true);
    });
});
