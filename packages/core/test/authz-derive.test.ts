import { describe, expect, it } from 'vitest';

import { assessRevision, pathsIntersectBoundary, pathsIntersectSecret } from '../src/authz/boundary.js';
import { derive, meetRule, type DeriveContext } from '../src/authz/derive.js';
import { isStrictlyWider } from '../src/authz/escalation.js';
import { AssetLabelRegistry } from '../src/authz/labels.js';
import { PRESETS, fullAccessGrant } from '../src/authz/presets.js';
import { RoleRegistry } from '../src/authz/roles.js';
import type {
    AgentGrant,
    BackendCapabilities,
    CapabilityRule,
    Role,
} from '../src/authz/types.js';

const HOME = '/home/tester';
const WORKSPACE = '/home/tester/work';

const labelRegistry = AssetLabelRegistry.builtin({ home: HOME, workspaceRoot: WORKSPACE });
const backend: BackendCapabilities = {
    id: 'test',
    supportsReversibility: ['domain-teardown', 'task-scratch'],
};

const roles = new RoleRegistry({
    'fs.read.workspace': { transfer: 'ingest', commit: 'recoverable', opacity: 'transparent' },
    'fs.read.host': { transfer: 'ingest', commit: 'recoverable', opacity: 'transparent' },
    'fs.write.workspace': { transfer: 'none', commit: 'recoverable', opacity: 'transparent' },
    'fs.write.host': { transfer: 'none', commit: 'recoverable', opacity: 'transparent' },
    'fs.write.sandbox': {
        transfer: 'none',
        commit: 'reversible',
        opacity: 'transparent',
        reversibleBy: 'domain-teardown',
    },
    'fs.exec': { transfer: 'none', commit: 'committed', opacity: 'transparent' },
    'net.send': { transfer: 'egress', commit: 'recoverable', opacity: 'transparent' },
    'net.fetch': { transfer: 'ingest', commit: 'recoverable', opacity: 'transparent' },
    delete: { transfer: 'none', commit: 'committed', opacity: 'transparent' },
    'mcp.srv': { transfer: 'none', commit: 'recoverable', opacity: 'opaque' },
});

function ctx(overrides: Partial<DeriveContext> = {}): DeriveContext {
    return {
        rootContractId: 'root-1',
        rootVersion: 1,
        taskId: 'task-1',
        roles,
        backend,
        labelRegistry,
        pinned: { labels: 1, roles: 2, rules: 3, rootTrust: 4 },
        ...overrides,
    };
}

function cap(
    action: string,
    domain: CapabilityRule['domain'],
    extra: Partial<CapabilityRule> = {},
): CapabilityRule {
    return { action, domain, tier: 'auto', ...extra };
}

describe('AuthorizationV2 meet (§5.2)', () => {
    it('only tightens the tier, scope and maxLabel', () => {
        const parent = cap('fs.read', 'workspace', { tier: 'gated', maxLabel: 'sensitive' });
        const child = cap('fs.read', 'workspace', {
            tier: 'auto',
            maxLabel: 'public',
            paths: ['/a', '/b'],
        });
        const met = meetRule(parent, child);
        expect(met.tier).toBe('gated');
        expect(met.maxLabel).toBe('sensitive');
        expect(met.paths).toEqual(['/a', '/b']);
    });

    it('intersects paths and takes the smaller amount limit', () => {
        const parent = cap('pay', 'external', {
            paths: ['/a', '/b'],
            amountLimit: { currency: 'USD', amount: 100 },
        });
        const child = cap('pay', 'external', {
            paths: ['/b', '/c'],
            amountLimit: { currency: 'USD', amount: 40 },
        });
        const met = meetRule(parent, child);
        expect(met.paths).toEqual(['/b']);
        expect(met.amountLimit).toEqual({ currency: 'USD', amount: 40 });
    });
});

describe('AuthorizationV2 derive flows', () => {
    it('rejects a required capability missing from the parent (fail-fast + revision)', () => {
        const parent: AgentGrant = { 'fs.read.workspace': cap('fs.read', 'workspace') };
        const result = derive(parent, { requires: ['fs.write.workspace'] }, ctx());
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.rejection.reason).toBe('DERIVE_REJECTED');
        expect(result.rejection.revision.requires).toEqual(['fs.write.workspace']);
    });

    it('pins the TCB versions and records the derived identity', () => {
        const parent: AgentGrant = { 'fs.read.workspace': cap('fs.read', 'workspace') };
        const result = derive(parent, { requires: ['fs.read.workspace'] }, ctx());
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.policy.pinned).toEqual({ labels: 1, roles: 2, rules: 3, rootTrust: 4 });
        expect(result.policy.derivedFrom).toEqual({
            rootContractId: 'root-1',
            rootVersion: 1,
            taskId: 'task-1',
        });
    });

    it('applies R1 for committed effects and R5 for boundary writes', () => {
        const parent: AgentGrant = {
            delete: cap('delete', 'workspace', { maxLabel: 'internal' }),
            'fs.write.workspace': cap('fs.write', 'workspace', {
                paths: [`${HOME}/.gitconfig`],
            }),
        };
        const result = derive(
            parent,
            { requires: ['delete', 'fs.write.workspace'] },
            ctx(),
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.policy.capabilities.delete.tier).toBe('gated');
        expect(result.policy.capabilities['fs.write.workspace'].tier).toBe('gated');
        expect(
            result.policy.capabilities['fs.write.workspace'].floors.map((h) => h.rule),
        ).toContain('R5');
    });

    it('forbids secret writes in the hard layer (V17)', () => {
        const parent: AgentGrant = {
            'fs.write.host': cap('fs.write', 'host', { paths: [`${HOME}/.ssh/config`] }),
        };
        const result = derive(parent, { requires: ['fs.write.host'] }, ctx());
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.policy.capabilities['fs.write.host'].tier).toBe('forbidden');
        expect(result.policy.capabilities['fs.write.host'].floors.map((h) => h.rule)).toContain(
            'V17',
        );
    });

    it('attaches an R3-flow condition for a sensitive source + egress sink', () => {
        const parent: AgentGrant = {
            'fs.read.workspace': cap('fs.read', 'workspace', { maxLabel: 'sensitive' }),
            'net.send': cap('net.send', 'external'),
        };
        const result = derive(
            parent,
            { requires: ['fs.read.workspace', 'net.send'] },
            ctx(),
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const sink = result.policy.capabilities['net.send'];
        expect(sink.conditions.map((c) => c.kind)).toContain('no-sensitive-ingest');
        expect(result.policy.conditions).toHaveLength(1);
        expect(result.policy.guardPairs).toEqual([
            { source: 'fs.read.workspace', sink: 'net.send', mode: 'flow' },
        ]);
    });

    it('R3-hard clamps the sink and forbids an unsevered secret source', () => {
        const parent: AgentGrant = {
            'fs.read.host': cap('fs.read', 'host', { maxLabel: 'secret', severance: 'plain' }),
            'net.send': cap('net.send', 'external'),
        };
        const result = derive(parent, { requires: ['fs.read.host', 'net.send'] }, ctx());
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.policy.capabilities['fs.read.host'].tier).toBe('forbidden');
        expect(result.policy.capabilities['net.send'].tier).toBe('gated');
        expect(result.policy.guardPairs).toContainEqual({
            source: 'fs.read.host',
            sink: 'net.send',
            mode: 'hard',
        });
    });

    it('lets a severed secret source remain executable while clamping the sink', () => {
        const parent: AgentGrant = {
            'fs.read.host': cap('fs.read', 'host', { maxLabel: 'secret', severance: 'handle' }),
            'net.send': cap('net.send', 'external'),
        };
        const result = derive(parent, { requires: ['fs.read.host', 'net.send'] }, ctx());
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.policy.capabilities['fs.read.host'].tier).not.toBe('forbidden');
        expect(result.policy.capabilities['net.send'].tier).toBe('gated');
    });

    it('strict deployment clamps sensitive sources hard and requires severance', () => {
        const parent: AgentGrant = {
            'fs.read.workspace': cap('fs.read', 'workspace', { maxLabel: 'sensitive' }),
            'net.send': cap('net.send', 'external'),
        };
        const result = derive(
            parent,
            { requires: ['fs.read.workspace', 'net.send'] },
            ctx({ strict: true }),
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.policy.capabilities['fs.read.workspace'].tier).toBe('forbidden');
        expect(result.policy.capabilities['net.send'].tier).toBe('gated');
        expect(result.policy.conditions).toHaveLength(0);
    });

    it('caps axes the backend cannot enforce (V15, forbidden by default)', () => {
        const restricted: BackendCapabilities = {
            id: 'restricted',
            supportsReversibility: [],
            unenforced: ['fs.read.host'],
        };
        const parent: AgentGrant = { 'fs.read.host': cap('fs.read', 'host') };
        const result = derive(parent, { requires: ['fs.read.host'] }, ctx({ backend: restricted }));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.policy.capabilities['fs.read.host'].tier).toBe('forbidden');
    });

    it('fails closed when the pinned snapshot is revoked', () => {
        const parent: AgentGrant = { 'fs.read.workspace': cap('fs.read', 'workspace') };
        const result = derive(
            parent,
            { requires: ['fs.read.workspace'] },
            ctx({ isRevoked: () => true }),
        );
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.rejection.reason).toBe('POLICY_REVOKED');
    });
});

describe('AuthorizationV2 presets', () => {
    it('derives the workspace-write preset', () => {
        const result = derive(
            PRESETS['workspace-write'],
            { requires: ['fs.read.workspace', 'fs.write.workspace'] },
            ctx(),
        );
        expect(result.ok).toBe(true);
    });

    it('full-access grants severing secret reads but never bypasses V17', () => {
        const grant = fullAccessGrant();
        const read = derive(grant, { requires: ['fs.read.host'] }, ctx());
        expect(read.ok).toBe(true);
        if (!read.ok) return;
        expect(read.policy.capabilities['fs.read.host'].tier).not.toBe('forbidden');

        const secretWrite = derive(
            { 'fs.write.host': cap('fs.write', 'host', { paths: [`${HOME}/.ssh/config`] }) },
            { requires: ['fs.write.host'] },
            ctx(),
        );
        expect(secretWrite.ok).toBe(true);
        if (!secretWrite.ok) return;
        expect(secretWrite.policy.capabilities['fs.write.host'].tier).toBe('forbidden');
    });
});

describe('AuthorizationV2 N19 fast-track revision', () => {
    const current: AgentGrant = {
        'fs.read.workspace': cap('fs.read', 'workspace', {
            paths: [`${HOME}/work/*`],
            maxLabel: 'internal',
        }),
    };

    it('detects boundary and secret intersections', () => {
        expect(pathsIntersectBoundary([`${HOME}/.gitconfig`], labelRegistry)).toBe(true);
        expect(pathsIntersectBoundary([`${HOME}/docs/*`], labelRegistry)).toBe(false);
        expect(pathsIntersectSecret([`${HOME}/.ssh/id_rsa`], labelRegistry)).toBe(true);
    });

    it('fast-tracks a benign path widening', () => {
        const assessment = assessRevision(current, {
            requires: ['fs.read.workspace'],
            wants: {
                'fs.read.workspace': cap('fs.read', 'workspace', {
                    paths: [`${HOME}/work/*`, `${HOME}/docs/*`],
                    maxLabel: 'internal',
                }),
            },
        }, labelRegistry);
        expect(assessment.fastTrack).toBe(true);
        expect(assessment.dualApproval).toBe(false);
    });

    it('falls back to dual sign-off when the new path touches the boundary set', () => {
        const assessment = assessRevision(current, {
            requires: ['fs.read.workspace'],
            wants: {
                'fs.read.workspace': cap('fs.read', 'workspace', {
                    paths: [`${HOME}/work/*`, `${HOME}/.gitconfig`],
                    maxLabel: 'internal',
                }),
            },
        }, labelRegistry);
        expect(assessment.dualApproval).toBe(true);
        expect(assessment.reasons.join()).toContain('边界集');
    });

    it('falls back to dual sign-off on a tier change', () => {
        const assessment = assessRevision(current, {
            requires: ['fs.read.workspace'],
            wants: {
                'fs.read.workspace': cap('fs.read', 'workspace', {
                    tier: 'gated',
                    paths: [`${HOME}/work/*`],
                    maxLabel: 'internal',
                }),
            },
        }, labelRegistry);
        expect(assessment.dualApproval).toBe(true);
    });
});

describe('AuthorizationV2 V12 escalation partial order', () => {
    const effective = cap('fs.read', 'workspace', {
        tier: 'auto',
        paths: ['/a'],
        maxLabel: 'internal',
    });

    it('is not strictly wider for equal or narrower requests', () => {
        expect(isStrictlyWider(effective, effective)).toBe(false);
        expect(
            isStrictlyWider(
                cap('fs.read', 'workspace', {
                    tier: 'auto',
                    paths: ['/a'],
                    maxLabel: 'public',
                }),
                effective,
            ),
        ).toBe(false);
    });

    it('is strictly wider for a higher tier or broader scope', () => {
        expect(isStrictlyWider(cap('fs.read', 'workspace', { tier: 'gated' }), effective)).toBe(true);
        expect(
            isStrictlyWider(
                cap('fs.read', 'workspace', { tier: 'auto', paths: ['/a', '/b'] }),
                effective,
            ),
        ).toBe(true);
        expect(
            isStrictlyWider(
                cap('pay', 'external', { tier: 'auto', amountLimit: { currency: 'USD', amount: 200 } }),
                cap('pay', 'external', { tier: 'auto', amountLimit: { currency: 'USD', amount: 50 } }),
            ),
        ).toBe(true);
    });
});
