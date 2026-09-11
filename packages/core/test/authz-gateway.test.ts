import { describe, expect, it } from 'vitest';

import { AuthorizationEngine } from '../src/authz/engine.js';
import {
    DefaultToolGateway,
    isInScope,
    projectValues,
} from '../src/authz/gateway.js';
import {
    type ApprovalDecision,
    type ApprovalRequest,
    type GatewayAuditEvent,
    type GatewayBindInput,
    GATEWAY_PIPELINE_STAGES,
    type ToolRegistration,
} from '../src/authz/gateway-types.js';
import { AssetLabelRegistry } from '../src/authz/labels.js';
import { DataflowLedger } from '../src/authz/ledger.js';
import { RoleRegistry } from '../src/authz/roles.js';
import { SecretRefResolver, type SecretRef } from '../src/authz/secret-ref.js';
import type { AgentGrant, BackendCapabilities } from '../src/authz/types.js';

const HOME = '/home/tester';
const WORKSPACE = '/home/tester/work';
const REPORT = `${WORKSPACE}/report.txt`;

const labelRegistry = AssetLabelRegistry.builtin({ home: HOME, workspaceRoot: WORKSPACE });
const backend: BackendCapabilities = {
    id: 'test',
    supportsReversibility: ['domain-teardown', 'task-scratch'],
};
const roles = new RoleRegistry({
    'fs.read.workspace': { transfer: 'ingest', commit: 'recoverable', opacity: 'transparent' },
    'fs.write.workspace': { transfer: 'none', commit: 'recoverable', opacity: 'transparent' },
    'fs.write.host': { transfer: 'none', commit: 'recoverable', opacity: 'transparent' },
    'net.send': { transfer: 'egress', commit: 'recoverable', opacity: 'transparent' },
    'fs.exec': { transfer: 'none', commit: 'committed', opacity: 'transparent' },
    delete: { transfer: 'none', commit: 'committed', opacity: 'transparent' },
});

const grant: AgentGrant = {
    'fs.read.workspace': {
        action: 'fs.read',
        domain: 'workspace',
        tier: 'auto',
        maxLabel: 'sensitive',
        severance: 'plain',
    },
    'fs.write.workspace': { action: 'fs.write', domain: 'workspace', tier: 'auto' },
    'net.send': { action: 'net.send', domain: 'external', tier: 'auto' },
    'fs.exec': { action: 'fs.exec', domain: 'sandbox', tier: 'auto' },
    delete: { action: 'delete', domain: 'workspace', tier: 'auto' },
    'fs.write.host': {
        action: 'fs.write',
        domain: 'host',
        tier: 'auto',
        paths: [`${HOME}/.ssh/config`],
    },
};

function collector(): { audit: { log(e: GatewayAuditEvent): void }; events: GatewayAuditEvent[] } {
    const events: GatewayAuditEvent[] = [];
    return { audit: { log: (e) => events.push(e) }, events };
}

function approving(scope: 'once' | 'session'): {
    seam: { decide(r: ApprovalRequest): Promise<ApprovalDecision> };
    requests: ApprovalRequest[];
} {
    const requests: ApprovalRequest[] = [];
    return {
        requests,
        seam: {
            decide: async (r) => {
                requests.push(r);
                return { decision: 'granted', scope };
            },
        },
    };
}

function tool(partial: Partial<ToolRegistration> & Pick<ToolRegistration, 'name' | 'capability'>): ToolRegistration {
    return {
        description: partial.name,
        parameters: { type: 'object' },
        scope: {},
        role: roles.roleOf(partial.capability) ?? {
            transfer: 'none',
            commit: 'recoverable',
            opacity: 'transparent',
        },
        trust: 'confined',
        handler: async () => ({ value: 'ok' }),
        ...partial,
    };
}

function setup(options: { approval?: GatewayBindInput['approval']; budget?: { steps?: number } } = {}) {
    const ledger = new DataflowLedger();
    const engine = new AuthorizationEngine({
        labelRegistry,
        roles,
        backend,
        ledger,
        pinned: { labels: labelRegistry.version, roles: roles.version, rules: 1, rootTrust: 1 },
        rootContractId: 'root-1',
        rootVersion: 1,
        taskId: 'task-1',
        now: () => 1000,
    });
    const derived = engine.derive(grant, {
        requires: Object.keys(grant) as string[],
    });
    if (!derived.ok) throw new Error('derive failed');
    const { audit, events } = collector();
    const registry = new Map<string, ToolRegistration>();
    const bind: GatewayBindInput = {
        identifiers: { rootGoalId: 'rg-1', goalId: 'g-1', taskId: 'task-1' },
        effective: derived.policy,
        engine,
        toolRegistry: registry,
        audit,
        ...(options.approval ? { approval: options.approval } : {}),
        ...(options.budget ? { budget: options.budget } : {}),
        now: () => 1000,
    };
    return { engine, registry, events, bind, ledger };
}

describe('AuthorizationV2 ToolGateway (11-stage pipeline)', () => {
    it('runs every stage in order for an auto capability', async () => {
        const s = setup();
        s.registry.set('read', tool({ name: 'read', capability: 'fs.read.workspace', scope: { pathParams: ['path'] } }));
        const gateway = new DefaultToolGateway(s.bind);
        const result = await gateway.invoke({ tool: 'read', args: { path: REPORT } });
        expect(result.kind).toBe('executed');
        const stages = s.events.map((e) => e.stage);
        expect(stages).toEqual([...GATEWAY_PIPELINE_STAGES]);
    });

    it('rejects unregistered tools (V5 closed-world)', async () => {
        const s = setup();
        const result = await new DefaultToolGateway(s.bind).invoke({ tool: 'nope', args: {} });
        expect(result).toMatchObject({ kind: 'rejected', code: 'FORBIDDEN_UNREGISTERED' });
    });

    it('rejects missing required args', async () => {
        const s = setup();
        s.registry.set(
            'read',
            tool({
                name: 'read',
                capability: 'fs.read.workspace',
                parameters: { type: 'object', required: ['path'] },
            }),
        );
        const result = await new DefaultToolGateway(s.bind).invoke({ tool: 'read', args: {} });
        expect(result).toMatchObject({ kind: 'rejected', code: 'INVALID_ARGS' });
    });

    it('rejects a forbidden capability (V17 secret write)', async () => {
        const s = setup();
        s.registry.set(
            'secretwrite',
            tool({
                name: 'secretwrite',
                capability: 'fs.write.host',
                scope: { pathParams: ['path'] },
            }),
        );
        const result = await new DefaultToolGateway(s.bind).invoke({
            tool: 'secretwrite',
            args: { path: `${HOME}/.ssh/config` },
        });
        expect(result).toMatchObject({ kind: 'rejected', code: 'FORBIDDEN_BY_POLICY' });
    });

    it('blocks V17 at the value layer when the actual path is secret', async () => {
        const s = setup();
        s.registry.set('write', tool({ name: 'write', capability: 'fs.write.workspace', scope: { pathParams: ['path'] } }));
        const result = await new DefaultToolGateway(s.bind).invoke({
            tool: 'write',
            args: { path: `${HOME}/.ssh/config` },
        });
        expect(result).toMatchObject({ kind: 'rejected', code: 'FORBIDDEN_BY_HARD_LAYER' });
    });

    it('fails closed when a gated call has no approval seam (V13)', async () => {
        const s = setup();
        s.registry.set('exec', tool({ name: 'exec', capability: 'fs.exec', scope: { commandParam: 'command' } }));
        const result = await new DefaultToolGateway(s.bind).invoke({
            tool: 'exec',
            args: { command: 'echo hi' },
        });
        expect(result).toMatchObject({ kind: 'rejected', code: 'APPROVAL_UNAVAILABLE' });
    });

    it('executes a gated call once approved and honours once vs session scope', async () => {
        const once = approving('once');
        const s = setup({ approval: once.seam });
        s.registry.set('exec', tool({ name: 'exec', capability: 'fs.exec', scope: { commandParam: 'command' } }));
        const gateway = new DefaultToolGateway(s.bind);
        expect((await gateway.invoke({ tool: 'exec', args: { command: 'echo 1' } })).kind).toBe('executed');
        expect((await gateway.invoke({ tool: 'exec', args: { command: 'echo 2' } })).kind).toBe('executed');
        expect(once.requests).toHaveLength(2);

        const session = approving('session');
        const s2 = setup({ approval: session.seam });
        s2.registry.set('exec', tool({ name: 'exec', capability: 'fs.exec', scope: { commandParam: 'command' } }));
        const gateway2 = new DefaultToolGateway(s2.bind);
        await gateway2.invoke({ tool: 'exec', args: { command: 'echo 1' } });
        await gateway2.invoke({ tool: 'exec', args: { command: 'echo 2' } });
        expect(session.requests).toHaveLength(1);
    });

    it('records condition verdicts for an R3-flow sink', async () => {
        const approved = approving('once');
        const s = setup({ approval: approved.seam });
        s.registry.set(
            'send',
            tool({ name: 'send', capability: 'net.send', dataEgress: true, scope: { hostParams: ['url'] } }),
        );
        const gateway = new DefaultToolGateway(s.bind);
        await gateway.invoke({ tool: 'send', args: { url: 'https://example.com' } });
        expect(
            s.events.some((e) => e.stage === 'scope-check' && e.detail === 'condition-satisfied'),
        ).toBe(true);

        s.engine.commitRead({
            label: 'sensitive',
            source: 'fs.read.workspace',
            stepId: 's1',
            transferDir: 'ingest',
        });
        await gateway.invoke({ tool: 'send', args: { url: 'https://example.com' } });
        expect(
            s.events.some((e) => e.stage === 'scope-check' && e.detail === 'condition-broken'),
        ).toBe(true);
        expect(approved.requests).toHaveLength(2);
    });

    it('rejects handles in generic egress (N4)', async () => {
        const approved = approving('session');
        const s = setup({ approval: approved.seam });
        s.registry.set(
            'send',
            tool({ name: 'send', capability: 'net.send', dataEgress: true, scope: { hostParams: ['url'] } }),
        );
        const result = await new DefaultToolGateway(s.bind).invoke({
            tool: 'send',
            args: { body: 'secretref:ref:s3' },
        });
        expect(result).toMatchObject({ kind: 'rejected', code: 'HANDLE_UNRESOLVABLE' });
    });

    it('honours the hook-chain deny absorbing state (V14)', async () => {
        const s = setup();
        let secondCalled = false;
        s.bind.hooks = [
            { id: 'h1', preExecute: () => ({ verdict: 'deny', code: 'FORBIDDEN_BY_POLICY', hint: 'no' }) },
            {
                id: 'h2',
                preExecute: () => {
                    secondCalled = true;
                    return { verdict: 'allow' };
                },
            },
        ];
        s.registry.set('read', tool({ name: 'read', capability: 'fs.read.workspace' }));
        const result = await new DefaultToolGateway(s.bind).invoke({ tool: 'read', args: {} });
        expect(result).toMatchObject({ kind: 'rejected', code: 'FORBIDDEN_BY_POLICY' });
        expect(secondCalled).toBe(false);
    });

    it('raises approval for a danger verb', async () => {
        const approved = approving('once');
        const s = setup({ approval: approved.seam });
        s.registry.set('exec', tool({ name: 'exec', capability: 'fs.exec', scope: { commandParam: 'command' } }));
        const result = await new DefaultToolGateway(s.bind).invoke({
            tool: 'exec',
            args: { command: 'rm -rf src/' },
        });
        expect(result.kind).toBe('executed');
        expect(s.events.some((e) => e.detail?.includes('danger-verb'))).toBe(true);
    });

    it('enforces the step budget', async () => {
        const s = setup({ budget: { steps: 1 } });
        s.registry.set('read', tool({ name: 'read', capability: 'fs.read.workspace' }));
        const gateway = new DefaultToolGateway(s.bind);
        expect((await gateway.invoke({ tool: 'read', args: {} })).kind).toBe('executed');
        expect((await gateway.invoke({ tool: 'read', args: {} }))).toMatchObject({
            code: 'BUDGET_EXHAUSTED',
        });
    });

    it('tags untrusted output and applies the derived-label overlay on write', async () => {
        const s = setup();
        s.registry.set(
            'fetch',
            tool({ name: 'fetch', capability: 'fs.read.workspace', untrustedOutput: true }),
        );
        const result = await new DefaultToolGateway(s.bind).invoke({ tool: 'fetch', args: {} });
        expect(result).toMatchObject({ kind: 'executed', untrusted: true });

        s.engine.commitRead({
            label: 'sensitive',
            source: 'fs.read.workspace',
            stepId: 's1',
            transferDir: 'ingest',
        });
        s.registry.set('write', tool({ name: 'write', capability: 'fs.write.workspace', scope: { pathParams: ['path'] } }));
        await new DefaultToolGateway(s.bind).invoke({ tool: 'write', args: { path: REPORT } });
        expect(s.engine.overlay.has(REPORT)).toBe(true);
    });

    it('downgrades full-trust tools to gated', async () => {
        const s = setup();
        s.registry.set(
            'mcp',
            tool({ name: 'mcp', capability: 'fs.read.workspace', trust: 'full' }),
        );
        const result = await new DefaultToolGateway(s.bind).invoke({ tool: 'mcp', args: {} });
        expect(result).toMatchObject({ code: 'APPROVAL_UNAVAILABLE' });
        expect(s.events.some((e) => e.detail === 'full-trust-invocation')).toBe(true);
    });

    it('resolves L1 secret refs into the handler without exposing the wire format', async () => {
        const approved = approving('session');
        const s = setup({ approval: approved.seam });
        const ref: SecretRef = {
            refId: 'ref:s3',
            label: 'secret',
            allowedSinks: ['aws.s3'],
            purpose: { service: 's3', actions: ['GetObject'], resourcePattern: 'arn:aws:s3:::bucket/*' },
            parseLevel: 'L1',
            credentialId: 'cred:aws',
        };
        const resolver = new SecretRefResolver({
            sign: (payload) => `sig:${payload.length}`,
            audit: { log: () => {} },
            toolMaxParseLevel: () => 'L1',
            now: () => 1000,
        });
        let seen: ReadonlyMap<string, unknown> | undefined;
        s.registry.set(
            'send',
            tool({
                name: 'send',
                capability: 'net.send',
                secrets: ['ref:s3'],
                invocation: () => ({
                    tool: 'aws.s3',
                    service: 's3',
                    action: 'GetObject',
                    target: 'arn:aws:s3:::bucket/key',
                }),
                handler: async (_args, ctx) => {
                    seen = ctx.credentials;
                    return { value: 'ok' };
                },
            }),
        );
        s.bind.secretRefs = new Map([['ref:s3', ref]]);
        s.bind.secretResolver = resolver;
        const result = await new DefaultToolGateway(s.bind).invoke({ tool: 'send', args: {} });
        expect(result.kind).toBe('executed');
        expect(seen?.get('ref:s3')).toMatchObject({ refId: 'ref:s3' });
    });
});

describe('AuthorizationV2 gateway helpers', () => {
    it('projects declared params and checks scope', () => {
        const projection = projectValues(
            { path: REPORT, url: 'https://example.com', amount: 5 },
            { pathParams: ['path'], hostParams: ['url'], amountParam: 'amount' },
        );
        expect(projection).toMatchObject({ path: REPORT, host: 'https://example.com' });
        expect(
            isInScope(projection, {
                action: 'fs.write',
                domain: 'workspace',
                tier: 'auto',
                paths: [`${WORKSPACE}/**`],
                amountLimit: { currency: 'USD', amount: 10 },
            }),
        ).toBe(true);
    });
});
