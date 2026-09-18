import { describe, expect, it } from 'vitest';

import { derive } from '../src/authz/derive.js';
import { DefaultToolGateway, isInScope, projectValues } from '../src/authz/gateway.js';
import type {
    ApprovalDecision,
    ApprovalSeam,
    GatewayAuditEvent,
    ToolRegistration,
} from '../src/authz/gateway-types.js';
import { AssetLabelRegistry } from '../src/authz/labels.js';
import { DataflowLedger, TaintTable } from '../src/authz/ledger.js';
import { SecretService } from '../src/authz/secret.js';
import type { Grant, ToolSemantics } from '../src/authz/types.js';

const HOME = '/home/tester';
const WORKSPACE = `${HOME}/work`;
const labels = AssetLabelRegistry.builtin({ home: HOME, workspaceRoot: WORKSPACE });

const SEMANTICS: Record<string, ToolSemantics> = {
    'fs.read.workspace': { ingest: true },
    'fs.read.host': { ingest: true, severance: true },
    'fs.write.workspace': {},
    'fs.exec': {},
    'net.send': { egress: true, dataEgress: true },
};

const GRANT: Grant = {
    caps: {
        'fs.read.workspace': { tier: 'auto' },
        'fs.read.host': { tier: 'auto', maxLabel: 'secret' },
        'fs.write.workspace': { tier: 'auto' },
        'fs.exec': { tier: 'auto' },
        'net.send': { tier: 'auto' },
    },
};

function tool(
    name: string,
    capability: string,
    scope: ToolRegistration['scope'] = {},
): ToolRegistration {
    return {
        name,
        description: name,
        parameters: {},
        capability,
        semantics: SEMANTICS[capability] ?? {},
        scope,
        trust: 'confined',
        handler: async () => ({ value: `ran:${name}` }),
    };
}

const TOOLS: ToolRegistration[] = [
    tool('read', 'fs.read.workspace', { pathParams: ['path'] }),
    tool('write', 'fs.write.workspace', { pathParams: ['path'] }),
    tool('shell', 'fs.exec', { commandParam: 'command' }),
    tool('egress', 'net.send'),
    {
        name: 'readSecret',
        description: 'readSecret',
        parameters: {},
        capability: 'fs.read.host',
        semantics: SEMANTICS['fs.read.host'] ?? {},
        scope: { pathParams: ['path'] },
        trust: 'confined',
        secretPurpose: { service: 'vault', actions: ['read'], resourcePattern: '*' },
        handler: async () => ({ value: '-----BEGIN PRIVATE KEY-----\nMIIsecret' }),
    },
];

function approving(decisions: ApprovalDecision[] = []): ApprovalSeam {
    return { decide: async () => decisions.shift() ?? { decision: 'granted', scope: 'once' } };
}

function rejecting(): ApprovalSeam {
    return { decide: async () => ({ decision: 'rejected', reason: 'no' }) };
}

function build(
    opts: { approval?: ApprovalSeam; audit?: GatewayAuditEvent[]; secretService?: SecretService } = {},
) {
    const derived = derive(
        GRANT,
        { requires: Object.keys(GRANT.caps) },
        {
            labels,
            semantics: SEMANTICS,
            pinned: { labels: labels.version, rules: 1, trust: 1 },
            rootId: 'r',
            rootVersion: 1,
            taskId: 't',
        },
    );
    if (!derived.ok) throw new Error(derived.rejection.hint);
    const ledger = new DataflowLedger();
    const taint = new TaintTable({ home: HOME });
    const audit = opts.audit ?? [];
    const gateway = new DefaultToolGateway({
        identifiers: { rootGoalId: 'r', goalId: 'g', taskId: 't' },
        policy: derived.policy,
        labels,
        ledger,
        taint,
        toolRegistry: new Map(TOOLS.map((t) => [t.name, t])),
        ...(opts.approval ? { approval: opts.approval } : {}),
        ...(opts.secretService ? { secretService: opts.secretService } : {}),
        audit: { log: (event) => audit.push(event) },
    });
    return { gateway, ledger, taint, audit };
}

const sensitivePath = `${HOME}/Documents/a.txt`;

describe('authz gateway value projection', () => {
    it('projects declared params and checks the declared range', () => {
        const projection = projectValues(
            { path: 'a', url: 'https://x' },
            { pathParams: ['path'], hostParams: ['url'] },
        );
        expect(projection).toEqual({ path: 'a', host: 'https://x' });
        expect(isInScope({ path: '/a/b' }, { paths: ['/a/*'] })).toBe(true);
        expect(isInScope({ path: '/b' }, { paths: ['/a/*'] })).toBe(false);
    });
});

describe('authz execution gateway', () => {
    it('commits a sensitive read to the ledger (INV-A)', async () => {
        const { gateway, ledger } = build();
        const result = await gateway.invoke({ tool: 'read', args: { path: sensitivePath } });
        expect(result).toMatchObject({ kind: 'executed' });
        expect(ledger.adjudicate().broken).toBe(true);
    });

    it('blocks egress after a sensitive read unless approval is obtained', async () => {
        const blocked = build();
        await blocked.gateway.invoke({ tool: 'read', args: { path: sensitivePath } });
        expect(await blocked.gateway.invoke({ tool: 'egress', args: { body: 'x' } })).toMatchObject(
            { kind: 'rejected', code: 'APPROVAL_UNAVAILABLE' },
        );

        const allowed = build({ approval: approving() });
        await allowed.gateway.invoke({ tool: 'read', args: { path: sensitivePath } });
        expect(await allowed.gateway.invoke({ tool: 'egress', args: { body: 'x' } })).toMatchObject(
            { kind: 'executed' },
        );
    });

    it('severs a secret read and returns a voucher instead of the plaintext', async () => {
        const secretService = new SecretService({
            sign: (payload, material) => `sig:${material.length}:${payload.length}`,
        });
        const { gateway, ledger } = build({ secretService });
        const result = await gateway.invoke({ tool: 'readSecret', args: { path: '~/.ssh/id_rsa' } });
        expect(result.kind).toBe('executed');
        if (result.kind === 'executed') {
            expect(JSON.stringify(result.value)).toContain('secretref:');
            expect(JSON.stringify(result.value)).not.toContain('BEGIN PRIVATE KEY');
        }
        expect(ledger.adjudicate().broken).toBe(false);
    });

    it('forbids a secret write at the hard floor', async () => {
        const { gateway } = build();
        expect(
            await gateway.invoke({ tool: 'write', args: { path: '~/.ssh/id_rsa' } }),
        ).toMatchObject({ kind: 'rejected', code: 'FORBIDDEN_BY_HARD_FLOOR' });
    });

    it('routes a Q1 danger verb through approval', async () => {
        const { gateway } = build({ approval: rejecting() });
        expect(
            await gateway.invoke({ tool: 'shell', args: { command: 'rm -rf src/' } }),
        ).toMatchObject({ kind: 'rejected', code: 'GATED_REJECTED' });
    });

    it('emits the full ordered stage list', async () => {
        const { gateway, audit } = build();
        await gateway.invoke({ tool: 'read', args: { path: sensitivePath } });
        const stages = audit.map((event) => event.stage);
        expect(stages[0]).toBe('supply-check');
        expect(stages).toContain('risk-check');
        expect(stages).toContain('ledger-adjudication');
        expect(stages[stages.length - 1]).toBe('audit');
    });
});
