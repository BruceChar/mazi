import { describe, expect, it } from 'vitest';

import { AssetLabelRegistry } from '../src/authz/labels.js';

const HOME = '/home/tester';
const WORKSPACE = '/home/tester/work';

const registry = AssetLabelRegistry.builtin({ home: HOME, workspaceRoot: WORKSPACE });

describe('authz labels', () => {
    it('treats an unannotated asset as internal', () => {
        const resolved = registry.resolve({ kind: 'path', value: `${WORKSPACE}/readme.md` });
        expect(resolved.label).toBe('internal');
        expect(resolved.boundary).toBe(false);
    });

    it('resolves platform secret patterns', () => {
        expect(registry.resolve({ kind: 'path', value: '~/.ssh/id_rsa' }).label).toBe('secret');
        expect(registry.resolve({ kind: 'path', value: `${WORKSPACE}/.env` }).label).toBe('secret');
        expect(registry.resolve({ kind: 'env', value: 'AWS_SECRET_ACCESS_KEY' }).label).toBe(
            'secret',
        );
    });

    it('flags permission-envelope boundary assets', () => {
        const crontab = registry.resolve({ kind: 'path', value: '/etc/crontab' });
        expect(crontab.boundary).toBe(true);
        expect(crontab.label).toBe('sensitive');

        const authorized = registry.resolve({ kind: 'path', value: '~/.ssh/authorized_keys' });
        expect(authorized.boundary).toBe(true);
        expect(authorized.label).toBe('secret');
    });

    it('lets a platform negative entry cancel a broader secret declaration', () => {
        const resolved = registry.resolve({ kind: 'path', value: '~/.ssh/id_rsa.pub' });
        expect(resolved.label).toBe('internal');
    });

    it('never lets a user declaration downgrade a platform secret', () => {
        const withUser = registry.withUserLabels([
            { kind: 'path', pattern: '**/.env*', label: 'public', specificity: 99 },
        ]);
        expect(withUser.resolve({ kind: 'path', value: `${WORKSPACE}/.env` }).label).toBe('secret');
    });

    it('scopes the home wildcard out of the workspace', () => {
        expect(registry.resolve({ kind: 'path', value: `${WORKSPACE}/a.txt` }).label).toBe(
            'internal',
        );
        expect(registry.resolve({ kind: 'path', value: `${HOME}/Documents/a.txt` }).label).toBe(
            'sensitive',
        );
    });
});
