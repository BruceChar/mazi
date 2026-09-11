import { describe, expect, it } from 'vitest';

import type { authz, HarnessEvent } from '@mazi/core';

import type { ToolCallResult, ToolConfig } from '../src/config.js';
import { ApprovalBroker } from '../src/tool-gateway/approval.js';
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
    it('maps the permission level to the auto boundary (above = gated)', () => {
        expect(grantForPermissionLevel('text')).toEqual({});
        const readOnly = grantForPermissionLevel('read-only');
        expect(readOnly['fs.read.workspace']).toMatchObject({ tier: 'auto' });
        expect(readOnly['fs.exec']).toMatchObject({ tier: 'gated' });
        expect(readOnly['fs.write.workspace']).toMatchObject({ tier: 'gated' });

        const draft = grantForPermissionLevel('draft');
        expect(draft['fs.exec']).toMatchObject({ tier: 'auto' });
        expect(draft['fs.write.workspace']).toMatchObject({ tier: 'auto' });
        expect(draft['net.send']).toMatchObject({ tier: 'gated' });
        expect(grantForPermissionLevel('approved')['net.send']).toMatchObject({ tier: 'auto' });
    });

    it('derives a valid action/domain for each granted capability', () => {
        const grant = grantForPermissionLevel('autonomous');
        expect(grant['fs.read.workspace']).toMatchObject({
            action: 'fs.read.workspace',
            domain: 'workspace',
        });
        expect(grant['fs.write.workspace']).toMatchObject({
            action: 'fs.write.workspace',
            domain: 'workspace',
        });
        expect(grant['net.fetch']).toMatchObject({ domain: 'external' });
        expect(grant['db.read']).toMatchObject({ domain: 'host' });
        expect(grant['fs.read.host']).toMatchObject({
            action: 'fs.read',
            domain: 'host',
            maxLabel: 'secret',
        });
    });

    it('derives the dispatch capability from the tool shape', () => {
        expect(capabilityForTool(TOOLS[0])).toBe('fs.read.workspace');
        expect(capabilityForTool(TOOLS[2])).toBe('fs.write.workspace');
        expect(capabilityForTool(TOOLS[3])).toBe('net.fetch');
        expect(capabilityForTool(TOOLS[4])).toBe('fs.exec');
    });

    it('offers the full surface with gated tools above the ceiling; only text hides them', () => {
        const readOnly = new RuntimeToolGateway({
            rootGoalId: 'r',
            goalId: 'g',
            taskId: 't',
            level: 'read-only',
            tools: TOOLS,
            execute,
        });
        expect(readOnly.visibleToolNames().sort()).toEqual([
            'fs.read',
            'rg',
            'sd',
            'shell.run',
            'xh',
        ]);

        const text = new RuntimeToolGateway({
            rootGoalId: 'r',
            goalId: 'g',
            taskId: 't',
            level: 'text',
            tools: TOOLS,
            execute,
        });
        expect(text.visibleToolNames()).toEqual([]);
    });

    it('exposes an above-ceiling tool and rejects it when approval is denied', async () => {
        const broker = new ApprovalBroker({ emit: () => {}, timeoutMs: 1000 });
        const gateway = new RuntimeToolGateway({
            rootGoalId: 'r',
            goalId: 'g',
            taskId: 't',
            level: 'read-only',
            tools: TOOLS,
            execute,
            approval: broker,
        });
        const pending = gateway.invoke('shell.run', { command: 'echo hi' });
        const requests = broker.pending();
        expect(requests).toHaveLength(1);
        broker.settle(requests[0].invocationId, { decision: 'rejected', reason: 'no' });
        await expect(pending).resolves.toMatchObject({ ok: false });
        expect((await pending).error).toContain('GATED_REJECTED');
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

    it('routes a gated call through an injected human approval seam', async () => {
        const events: HarnessEvent[] = [];
        const broker = new ApprovalBroker({
            emit: (event) => events.push(event),
            timeoutMs: 1000,
        });
        const gateway = new RuntimeToolGateway({
            rootGoalId: 'r',
            goalId: 'g',
            taskId: 't',
            level: 'draft',
            tools: TOOLS,
            execute,
            approval: broker,
        });
        const pending = gateway.invoke('shell.run', { command: 'echo hi' }, { stepId: 's-9' });
        const requests = broker.pending();
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ tool: 'shell.run', capability: 'fs.exec' });
        broker.settle(requests[0].invocationId, { decision: 'granted', scope: 'once' });
        await expect(pending).resolves.toMatchObject({ ok: true });
        expect(events.some((event) => event.type === 'approval.requested')).toBe(true);
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
