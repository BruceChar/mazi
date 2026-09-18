import { describe, expect, it } from 'vitest';

import { authz, type HarnessEvent } from '@mazi/core';

import type { ToolCallResult, ToolConfig } from '../src/config.js';
import { ApprovalBroker } from '../src/tool-gateway/approval.js';
import {
    capabilityForTool,
    grantForPermissionLevel,
    RUNTIME_SEMANTICS,
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
        expect(grantForPermissionLevel('text')).toEqual({ caps: {} });
        const readOnly = grantForPermissionLevel('read-only');
        expect(readOnly.caps['fs.read.workspace']).toMatchObject({ tier: 'auto' });
        expect(readOnly.caps['fs.exec']).toMatchObject({ tier: 'gated' });
        expect(readOnly.caps['fs.write.workspace']).toMatchObject({ tier: 'gated' });

        const workspaceWrite = grantForPermissionLevel('workspace-write');
        expect(workspaceWrite.caps['fs.read.workspace']).toMatchObject({ tier: 'auto' });
        expect(workspaceWrite.caps['fs.write.workspace']).toMatchObject({ tier: 'auto' });
        // 工作区写信任本地命令执行；联网仍 gated
        expect(workspaceWrite.caps['fs.exec']).toMatchObject({ tier: 'auto' });
        expect(workspaceWrite.caps['net.fetch']).toMatchObject({ tier: 'gated' });

        const draft = grantForPermissionLevel('draft');
        expect(draft.caps['fs.exec']).toMatchObject({ tier: 'auto' });
        expect(draft.caps['fs.write.workspace']).toMatchObject({ tier: 'auto' });
        expect(draft.caps['net.send']).toMatchObject({ tier: 'gated' });
        expect(grantForPermissionLevel('approved').caps['net.send']).toMatchObject({ tier: 'auto' });
    });

    it('declares the reachable max label and three-question semantics per capability', () => {
        const grant = grantForPermissionLevel('autonomous');
        expect(grant.caps['fs.read.workspace']).toMatchObject({ maxLabel: 'internal' });
        expect(grant.caps['fs.write.workspace']).toMatchObject({ maxLabel: 'sensitive' });
        expect(grant.caps['net.fetch']).toMatchObject({ maxLabel: 'internal' });
        expect(grant.caps['db.read']).toMatchObject({ maxLabel: 'sensitive' });
        expect(grant.caps['fs.read.host']).toMatchObject({ maxLabel: 'secret' });
        expect(RUNTIME_SEMANTICS['fs.read.workspace']).toMatchObject({ ingest: true });
        expect(RUNTIME_SEMANTICS['net.send']).toMatchObject({ egress: true, dataEgress: true });
        expect(RUNTIME_SEMANTICS['pay']).toMatchObject({ irreversible: true });
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

    it('workspace-write runs local commands without approval but still gates dangerous ones', async () => {
        const broker = new ApprovalBroker({ emit: () => {}, timeoutMs: 1000 });
        const gateway = new RuntimeToolGateway({
            rootGoalId: 'r',
            goalId: 'g',
            taskId: 't',
            level: 'workspace-write',
            tools: TOOLS,
            execute,
            approval: broker,
        });
        // 工具链命令是 unknown，随 tier auto → 不审批
        await expect(gateway.invoke('shell.run', { command: 'cargo build' })).resolves.toMatchObject({
            ok: true,
        });
        expect(broker.pending()).toHaveLength(0);

        // 危险命令仍需审批
        const pending = gateway.invoke('shell.run', { command: 'rm -rf target' });
        const requests = broker.pending();
        expect(requests).toHaveLength(1);
        broker.settle(requests[0].invocationId, { decision: 'rejected', reason: 'no' });
        await expect(pending).resolves.toMatchObject({ ok: false });
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
        const pending = gateway.invoke('shell.run', { command: 'rm -rf src/' }, { stepId: 's-9' });
        const requests = broker.pending();
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ tool: 'shell.run', capability: 'fs.exec' });
        broker.settle(requests[0].invocationId, { decision: 'granted', scope: 'once' });
        await expect(pending).resolves.toMatchObject({ ok: true });
        expect(events.some((event) => event.type === 'approval.requested')).toBe(true);
    });

    it('workspace 授权跨 RuntimeToolGateway 复用，不重复审批', async () => {
        const store = new authz.InMemoryApprovalStore();
        const broker = new ApprovalBroker({ emit: () => {}, timeoutMs: 1000 });
        const first = new RuntimeToolGateway({
            rootGoalId: 'r',
            goalId: 'g',
            taskId: 't',
            level: 'read-only',
            tools: TOOLS,
            execute,
            approval: broker,
            approvalStore: store,
        });
        const pending = first.invoke('shell.run', { command: 'ping baidu.com' });
        const requests = broker.pending();
        expect(requests).toHaveLength(1);
        broker.settle(requests[0].invocationId, { decision: 'granted', scope: 'workspace' });
        await expect(pending).resolves.toMatchObject({ ok: true });

        const neverAsk: authz.ApprovalSeam = {
            decide: async () => {
                throw new Error('不应再次请求审批');
            },
        };
        const second = new RuntimeToolGateway({
            rootGoalId: 'r2',
            goalId: 'g2',
            taskId: 't2',
            level: 'read-only',
            tools: TOOLS,
            execute,
            approval: neverAsk,
            approvalStore: store,
        });
        // 只读命令按命令名放宽：换目标域名命中同一工作区授权
        await expect(
            second.invoke('shell.run', { command: 'ping bilibili.com' }),
        ).resolves.toMatchObject({ ok: true });
    });

    it('审批绑定具体命令与会话作用域', async () => {
        const store = new authz.InMemoryApprovalStore();
        const broker = new ApprovalBroker({ emit: () => {}, timeoutMs: 1000 });
        const first = new RuntimeToolGateway({
            rootGoalId: 'r',
            goalId: 'g',
            taskId: 't',
            level: 'read-only',
            tools: TOOLS,
            execute,
            approval: broker,
            approvalStore: store,
            sessionId: 'c1',
        });
        const pending = first.invoke('shell.run', { command: 'ping baidu.com' });
        broker.settle(broker.pending()[0].invocationId, { decision: 'granted', scope: 'session' });
        await expect(pending).resolves.toMatchObject({ ok: true });

        const noAsk: authz.ApprovalSeam = {
            decide: async () => {
                throw new Error('不应再次请求审批');
            },
        };
        const rejectAsk: authz.ApprovalSeam = {
            decide: async () => ({ decision: 'rejected', reason: '需要单独审批' }),
        };
        const sameSessionSameCommand = new RuntimeToolGateway({
            rootGoalId: 'r2',
            goalId: 'g2',
            taskId: 't2',
            level: 'read-only',
            tools: TOOLS,
            execute,
            approval: noAsk,
            approvalStore: store,
            sessionId: 'c1',
        });
        await expect(
            sameSessionSameCommand.invoke('shell.run', { command: 'ping baidu.com' }),
        ).resolves.toMatchObject({ ok: true });

        const sameSessionOtherCommand = new RuntimeToolGateway({
            rootGoalId: 'r3',
            goalId: 'g3',
            taskId: 't3',
            level: 'read-only',
            tools: TOOLS,
            execute,
            approval: rejectAsk,
            approvalStore: store,
            sessionId: 'c1',
        });
        await expect(
            sameSessionOtherCommand.invoke('shell.run', { command: 'netstat -an' }),
        ).resolves.toMatchObject({ ok: false });

        const otherSessionSameCommand = new RuntimeToolGateway({
            rootGoalId: 'r4',
            goalId: 'g4',
            taskId: 't4',
            level: 'read-only',
            tools: TOOLS,
            execute,
            approval: rejectAsk,
            approvalStore: store,
            sessionId: 'c2',
        });
        await expect(
            otherSessionSameCommand.invoke('shell.run', { command: 'ping baidu.com' }),
        ).resolves.toMatchObject({ ok: false });
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
        expect(events.map((e) => e.stage)).toContain('risk-check');
        expect(events.some((e) => e.identifiers.stepId === 's-1')).toBe(true);
    });
});
