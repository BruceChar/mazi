import { describe, expect, it } from 'vitest';

import {
    applyBackendCap,
    applyHardLayer,
    evaluateLowerBounds,
    isWriteAction,
    resolveCapabilityTier,
    strictestTier,
    UNENFORCED_AXIS_DISCLOSURE,
} from '../src/authz/rules.js';
import { resolveEffectiveRole } from '../src/authz/roles.js';
import type { BackendCapabilities, CapabilityRule, Role } from '../src/authz/types.js';

const BACKEND: BackendCapabilities = {
    id: 'test-backend',
    supportsReversibility: ['domain-teardown', 'task-scratch'],
};

const readRole: Role = { transfer: 'ingest', commit: 'recoverable', opacity: 'transparent' };
const writeRole: Role = { transfer: 'none', commit: 'recoverable', opacity: 'transparent' };
const egressRole: Role = { transfer: 'egress', commit: 'recoverable', opacity: 'transparent' };
const opaqueRole: Role = { transfer: 'none', commit: 'recoverable', opacity: 'opaque' };

function rule(partial: Partial<CapabilityRule> & Pick<CapabilityRule, 'action' | 'domain'>): CapabilityRule {
    return { tier: 'auto', ...partial };
}

function lower(role: Role, ruleInput: CapabilityRule, boundary?: boolean) {
    return evaluateLowerBounds({
        capability: `${ruleInput.action}.${ruleInput.domain}`,
        rule: ruleInput,
        meetTier: 'auto',
        role,
        boundary,
        sourceVersion: 1,
    });
}

describe('AuthorizationV2 tier algebra', () => {
    it('takes the strictest tier', () => {
        expect(strictestTier('auto', 'gated', 'auto')).toBe('gated');
        expect(strictestTier('gated', 'forbidden')).toBe('forbidden');
    });

    it('resolves hard ⊔ floor ⊔ meet with hard winning (P24)', () => {
        expect(resolveCapabilityTier('auto', 'gated', 'forbidden')).toBe('forbidden');
        expect(resolveCapabilityTier('gated', 'gated', 'auto')).toBe('gated');
        expect(resolveCapabilityTier('auto', 'auto', 'auto')).toBe('auto');
    });
});

describe('AuthorizationV2 R1–R6 lower bounds', () => {
    it('R1: committed effects are gated regardless of tier', () => {
        const committed: Role = { ...writeRole, commit: 'committed' };
        const result = lower(committed, rule({ action: 'delete', domain: 'workspace' }));
        expect(result.floor).toBe('gated');
        expect(result.hits.map((h) => h.rule)).toContain('R1');
    });

    it('R2: egress is gated', () => {
        const result = lower(egressRole, rule({ action: 'net.send', domain: 'external' }));
        expect(result.floor).toBe('gated');
        expect(result.hits.map((h) => h.rule)).toContain('R2');
    });

    it('R4: opaque tools get the worst-role floor', () => {
        const result = lower(opaqueRole, rule({ action: 'external.mcp', domain: 'external' }));
        expect(result.floor).toBe('gated');
        expect(result.hits.map((h) => h.rule)).toContain('R4');
    });

    it('R5: boundary writes are gated and emit boundary-write', () => {
        const result = lower(writeRole, rule({ action: 'fs.write', domain: 'host' }), true);
        expect(result.floor).toBe('gated');
        expect(result.hits).toEqual(
            expect.arrayContaining([expect.objectContaining({ rule: 'R5', detail: 'boundary-write' })]),
        );
    });

    it('R5: boundary reads do not trigger the write floor', () => {
        const result = lower(readRole, rule({ action: 'fs.read', domain: 'host' }), true);
        expect(result.floor).toBe('auto');
        expect(result.hits.map((h) => h.rule)).not.toContain('R5');
    });

    it('R6: requires a backend-supported reversibility credential', () => {
        const reversible: Role = {
            transfer: 'none',
            commit: 'reversible',
            opacity: 'transparent',
            reversibleBy: 'task-scratch',
        };
        const supported = resolveEffectiveRole(reversible, BACKEND);
        expect(supported.credentialBypassed).toBe(false);
        expect(lower(supported, rule({ action: 'fs.write', domain: 'workspace' })).hits.map((h) => h.rule)).toContain(
            'R6',
        );

        const unsupported = resolveEffectiveRole(reversible, {
            id: 'no-credential',
            supportsReversibility: [],
        });
        expect(unsupported.commit).toBe('recoverable');
        expect(unsupported.credentialBypassed).toBe(true);
        expect(
            lower(unsupported, rule({ action: 'fs.write', domain: 'workspace' })).hits.map((h) => h.rule),
        ).not.toContain('R6');
    });
});

describe('AuthorizationV2 hard layer precedence', () => {
    it('V17: secret writes are forbidden, secret reads are not', () => {
        const write = applyHardLayer({
            capability: 'fs.write.host',
            rule: rule({ action: 'fs.write', domain: 'host' }),
            staticLabel: 'secret',
            sourceVersion: 1,
        });
        expect(write.hard).toBe('forbidden');
        expect(write.hits[0].rule).toBe('V17');

        const read = applyHardLayer({
            capability: 'fs.read.host',
            rule: rule({ action: 'fs.read', domain: 'host' }),
            staticLabel: 'secret',
            sourceVersion: 1,
        });
        expect(read.hard).toBe('auto');
    });

    it('V17 wins over R5 for a secret boundary write', () => {
        const boundaryRule = rule({ action: 'fs.write', domain: 'host' });
        const floor = lower(writeRole, boundaryRule, true);
        const hard = applyHardLayer({
            capability: 'fs.write.host',
            rule: boundaryRule,
            staticLabel: 'secret',
            sourceVersion: 1,
        });
        expect(floor.floor).toBe('gated');
        expect(resolveCapabilityTier('auto', floor.floor, hard.hard)).toBe('forbidden');
    });

    it('overlay labels never reach the hard layer (P24)', () => {
        const hard = applyHardLayer({
            capability: 'fs.write.workspace',
            rule: rule({ action: 'fs.write', domain: 'workspace' }),
            staticLabel: 'sensitive',
            sourceVersion: 1,
        });
        expect(hard.hard).toBe('auto');
        expect(hard.hits).toHaveLength(0);
    });
});

describe('AuthorizationV2 V15 backend cap', () => {
    const backend: BackendCapabilities = {
        id: 'restricted',
        supportsReversibility: [],
        unenforced: ['fs.read.host'],
    };

    it('defaults to forbidden when the backend cannot enforce an axis', () => {
        const result = applyBackendCap({
            capability: 'fs.read.host',
            rule: rule({ action: 'fs.read', domain: 'host' }),
            tier: 'auto',
            backend,
            sourceVersion: 1,
        });
        expect(result.tier).toBe('forbidden');
        expect(result.hits[0].rule).toBe('V15');
    });

    it('gated mode keeps gated and mandates the disclosure', () => {
        const result = applyBackendCap({
            capability: 'fs.read.host',
            rule: rule({ action: 'fs.read', domain: 'host' }),
            tier: 'auto',
            backend,
            unenforcedPolicy: [{ axis: 'fs.read.host', mode: 'gated' }],
            sourceVersion: 1,
        });
        expect(result.tier).toBe('gated');
        expect(result.disclosure).toBe(UNENFORCED_AXIS_DISCLOSURE);
    });

    it('detects write actions for R5', () => {
        expect(isWriteAction('fs.write')).toBe(true);
        expect(isWriteAction('delete')).toBe(true);
        expect(isWriteAction('fs.read')).toBe(false);
        expect(isWriteAction('net.send')).toBe(false);
    });
});
