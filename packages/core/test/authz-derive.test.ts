import { describe, expect, it } from 'vitest';

import { derive } from '../src/authz/derive.js';
import { AssetLabelRegistry } from '../src/authz/labels.js';
import type { Grant, TaskRequest } from '../src/authz/types.js';

const HOME = '/home/tester';
const labels = AssetLabelRegistry.builtin({ home: HOME, workspaceRoot: `${HOME}/work` });

function context(overrides: Partial<Parameters<typeof derive>[2]> = {}) {
    return {
        labels,
        pinned: { labels: labels.version, rules: 1, trust: 1 },
        rootId: 'root',
        rootVersion: 1,
        taskId: 'task',
        ...overrides,
    };
}

function deriveOk(root: Grant, request: TaskRequest, overrides = {}) {
    const result = derive(root, request, context(overrides));
    if (!result.ok) throw new Error(result.rejection.hint);
    return result.policy;
}

describe('authz derive', () => {
    it('omits capabilities that were not requested (closed world)', () => {
        const policy = deriveOk(
            { caps: { 'fs.read.workspace': { tier: 'auto' }, 'fs.exec': { tier: 'auto' } } },
            { requires: ['fs.read.workspace'] },
        );
        expect(Object.keys(policy.capabilities)).toEqual(['fs.read.workspace']);
    });

    it('rejects a required capability absent from the parent grant', () => {
        const result = derive(
            { caps: {} },
            { requires: ['fs.exec'] },
            context(),
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.rejection.code).toBe('DERIVE_REJECTED');
    });

    it('meets parent and request by strictest tier, intersected range and max label', () => {
        const policy = deriveOk(
            {
                caps: {
                    'fs.write.workspace': {
                        tier: 'auto',
                        paths: ['/a', '/b'],
                        maxLabel: 'internal',
                    },
                },
            },
            {
                requires: [],
                wants: {
                    'fs.write.workspace': {
                        tier: 'gated',
                        paths: ['/b', '/c'],
                        maxLabel: 'sensitive',
                    },
                },
            },
        );
        const effective = policy.capabilities['fs.write.workspace'];
        expect(effective?.tier).toBe('gated');
        expect(effective?.spec.paths).toEqual(['/b']);
        expect(effective?.spec.maxLabel).toBe('sensitive');
    });

    it('applies the declared three-question floor on top of the meet', () => {
        const policy = deriveOk(
            { caps: { pay: { tier: 'auto' } } },
            { requires: ['pay'] },
            { semantics: { pay: { irreversible: true } } },
        );
        expect(policy.capabilities.pay?.tier).toBe('gated');
    });

    it('clamps a static secret write to forbidden', () => {
        const policy = deriveOk(
            {
                caps: {
                    'fs.write.workspace': { tier: 'auto', paths: ['~/.ssh/id_rsa'] },
                },
            },
            { requires: ['fs.write.workspace'] },
        );
        expect(policy.capabilities['fs.write.workspace']?.tier).toBe('forbidden');
    });

    it('pins the TCB versions in the snapshot', () => {
        const pinned = { labels: 7, rules: 8, trust: 9 };
        const result = derive({ caps: { a: { tier: 'auto' } } }, { requires: ['a'] }, context({ pinned }));
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.policy.pinned).toEqual(pinned);
    });
});
