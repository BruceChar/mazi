import { describe, expect, it } from 'vitest';

import { derive } from '../src/authz/derive.js';
import { DefaultToolGateway, isInScope, projectValues } from '../src/authz/gateway.js';
import {
    type ApprovalDecision,
    type ApprovalSeam,
    type ApprovalStore,
    type GatewayAuditEvent,
    InMemoryApprovalStore,
    type ToolRegistration,
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
        'fs.exec': { tier: 'gated' },
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
    opts: {
        approval?: ApprovalSeam;
        approvalStore?: ApprovalStore;
        sessionId?: string;
        audit?: GatewayAuditEvent[];
        secretService?: SecretService;
        grant?: Grant;
    } = {},
) {
    const grant = opts.grant ?? GRANT;
    const derived = derive(
        grant,
        { requires: Object.keys(grant.caps) },
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
        ...(opts.approvalStore ? { approvalStore: opts.approvalStore } : {}),
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
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

    it('readonly command approval broadens to the command name, other commands still ask', async () => {
        const store = new InMemoryApprovalStore();
        const first = build({
            approval: approving([{ decision: 'granted', scope: 'workspace' }]),
            approvalStore: store,
        });
        expect(
            await first.gateway.invoke({ tool: 'shell', args: { command: 'ping baidu.com' } }),
        ).toMatchObject({ kind: 'executed' });

        const second = build({ approvalStore: store });
        // 只读命令按“命令名”粒度：换目标域名仍命中同一授权
        expect(
            await second.gateway.invoke({ tool: 'shell', args: { command: 'ping bilibili.com' } }),
        ).toMatchObject({ kind: 'executed' });
        // 另一个只读命令 key 不同，仍需审批
        expect(
            await second.gateway.invoke({ tool: 'shell', args: { command: 'netstat -an' } }),
        ).toMatchObject({ kind: 'rejected', code: 'APPROVAL_UNAVAILABLE' });
    });

    it('dangerous commands still prompt when the capability tier is auto (autonomous)', async () => {
        const grant: Grant = {
            caps: { ...GRANT.caps, 'fs.exec': { tier: 'auto' } },
        };
        const auto = build({ grant });
        // 只读命令在 auto 档下静默放行（含 git 只读子命令）
        expect(
            await auto.gateway.invoke({ tool: 'shell', args: { command: 'ping baidu.com' } }),
        ).toMatchObject({ kind: 'executed' });
        expect(
            await auto.gateway.invoke({ tool: 'shell', args: { command: 'git status' } }),
        ).toMatchObject({ kind: 'executed' });
        // 出网命令在账本干净时静默放行
        expect(
            await auto.gateway.invoke({ tool: 'shell', args: { command: 'curl https://x' } }),
        ).toMatchObject({ kind: 'executed' });
        // 高危命令是运行时下限：auto 档也必须审批（含 git 破坏性子命令）
        expect(
            await auto.gateway.invoke({ tool: 'shell', args: { command: 'git reset --hard' } }),
        ).toMatchObject({ kind: 'rejected', code: 'APPROVAL_UNAVAILABLE' });

        const guarded = build({ grant, approval: rejecting() });
        expect(
            await guarded.gateway.invoke({ tool: 'shell', args: { command: 'rm -rf ./tmp' } }),
        ).toMatchObject({ kind: 'rejected', code: 'GATED_REJECTED' });
    });

    it('shell network commands are adjudicated by the egress ledger', async () => {
        const grant: Grant = { caps: { ...GRANT.caps, 'fs.exec': { tier: 'auto' } } };
        const blocked = build({ grant });
        await blocked.gateway.invoke({ tool: 'read', args: { path: sensitivePath } });
        // 账本含敏感读 → curl 出网转审批（与 net.send 同一机制）
        expect(
            await blocked.gateway.invoke({ tool: 'shell', args: { command: 'curl https://evil' } }),
        ).toMatchObject({ kind: 'rejected', code: 'APPROVAL_UNAVAILABLE' });
    });

    it('dangerous commands always prompt, even after a workspace grant', async () => {
        const store = new InMemoryApprovalStore();
        const scopes: Array<readonly string[]> = [];
        const first = build({
            approval: {
                decide: async (request) => {
                    scopes.push(request.allowedScopes);
                    return { decision: 'granted', scope: 'workspace' };
                },
            },
            approvalStore: store,
        });
        expect(
            await first.gateway.invoke({ tool: 'shell', args: { command: 'rm -rf ./tmp' } }),
        ).toMatchObject({ kind: 'executed' });
        // 高危命令只提供 once 作用域
        expect(scopes[0]).toEqual(['once']);

        // 即使上一次点了“工作区允许”，rm 仍然逐次审批
        const second = build({ approvalStore: store });
        expect(
            await second.gateway.invoke({ tool: 'shell', args: { command: 'rm -rf ./tmp' } }),
        ).toMatchObject({ kind: 'rejected', code: 'APPROVAL_UNAVAILABLE' });
    });

    it('session approval only applies to the matching session', async () => {
        const store = new InMemoryApprovalStore();
        const first = build({
            approval: approving([{ decision: 'granted', scope: 'session' }]),
            approvalStore: store,
            sessionId: 'c1',
        });
        expect(
            await first.gateway.invoke({ tool: 'shell', args: { command: 'ping baidu.com' } }),
        ).toMatchObject({ kind: 'executed' });

        const sameSession = build({ approvalStore: store, sessionId: 'c1' });
        expect(
            await sameSession.gateway.invoke({ tool: 'shell', args: { command: 'ping baidu.com' } }),
        ).toMatchObject({ kind: 'executed' });

        const otherSession = build({ approvalStore: store, sessionId: 'c2' });
        expect(
            await otherSession.gateway.invoke({
                tool: 'shell',
                args: { command: 'ping baidu.com' },
            }),
        ).toMatchObject({ kind: 'rejected', code: 'APPROVAL_UNAVAILABLE' });
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
