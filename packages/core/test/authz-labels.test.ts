import { describe, expect, it } from 'vitest';

import { globToRegExp, matchGlob, specificityOf } from '../src/authz/glob.js';
import {
    aggregateSuppressions,
    AssetLabelRegistry,
    formatSuppressionNotice,
} from '../src/authz/labels.js';
import type { AssetLabel } from '../src/authz/types.js';

const HOME = '/home/tester';
const WORKSPACE = '/home/tester/work';

function registry(userLabels: AssetLabel[] = []): AssetLabelRegistry {
    return AssetLabelRegistry.builtin({ home: HOME, workspaceRoot: WORKSPACE }).withUserLabels(
        userLabels,
    );
}

describe('AuthorizationV2 label glob dialect', () => {
    it('treats ** as spanning path separators and * as segment-bounded', () => {
        expect(matchGlob('**/.env', '/home/tester/.env')).toBe(true);
        expect(matchGlob('**/.env', 'a/b/.env')).toBe(true);
        expect(matchGlob('**/.env', 'a/b/env')).toBe(false);
        expect(matchGlob('/etc/*', '/etc/passwd')).toBe(true);
        expect(matchGlob('/etc/*', '/etc/ssh/sshd_config')).toBe(false);
    });

    it('escapes regexp metacharacters in patterns', () => {
        expect(globToRegExp('a.b').test('axb')).toBe(false);
        expect(globToRegExp('a.b').test('a.b')).toBe(true);
    });

    it('computes specificity as non-wildcard character count', () => {
        expect(specificityOf('**/*.pem')).toBe(5);
        expect(specificityOf('**/*.pub.pem')).toBe(9);
    });
});

describe('AuthorizationV2 N15 label resolution', () => {
    it('fails safe: unannotated assets are internal (P13/N1)', () => {
        expect(registry().resolve({ kind: 'path', value: '/tmp/plain.txt' }).label).toBe(
            'internal',
        );
    });

    it('platform secret annotation applies to .env and private keys', () => {
        expect(registry().resolve({ kind: 'path', value: `${HOME}/.env` }).label).toBe('secret');
        expect(registry().resolve({ kind: 'path', value: `${HOME}/.ssh/id_rsa` }).label).toBe(
            'secret',
        );
    });

    it('negative entries are the legal secret-downgrade outlet (B1)', () => {
        expect(registry().resolve({ kind: 'path', value: `${HOME}/.env.example` }).label).toBe(
            'internal',
        );
        expect(registry().resolve({ kind: 'path', value: `${HOME}/id_rsa.pub` }).label).toBe(
            'internal',
        );
        expect(registry().resolve({ kind: 'path', value: '/certs/chain.pem' }).label).toBe(
            'internal',
        );
        expect(
            registry().resolve({ kind: 'path', value: '/certs/ca-certificates/root.pem' }).label,
        ).toBe('internal');
        expect(registry().resolve({ kind: 'path', value: '/keys/signing.pub.pem' }).label).toBe(
            'internal',
        );
    });

    it('marks identity and tool-config boundary assets (R5)', () => {
        const authKeys = registry().resolve({
            kind: 'path',
            value: `${HOME}/.ssh/authorized_keys`,
        });
        expect(authKeys.label).toBe('secret');
        expect(authKeys.boundary).toBe(true);

        const crontab = registry().resolve({ kind: 'path', value: '/etc/crontab' });
        expect(crontab.label).toBe('sensitive');
        expect(crontab.boundary).toBe(true);

        const gitconfig = registry().resolve({ kind: 'path', value: `${HOME}/.gitconfig` });
        expect(gitconfig.label).toBe('sensitive');
        expect(gitconfig.boundary).toBe(true);
    });

    it('keeps user data outside the workspace sensitive but workspace files internal', () => {
        expect(registry().resolve({ kind: 'path', value: `${HOME}/notes.txt` }).label).toBe(
            'sensitive',
        );
        expect(registry().resolve({ kind: 'path', value: `${WORKSPACE}/src/a.ts` }).label).toBe(
            'internal',
        );
    });

    it('suppresses user downgrades of secret assets and raises an audit event', () => {
        const resolved = registry([
            { kind: 'path', pattern: '**/.env', label: 'internal', origin: 'user' },
        ]).resolve({ kind: 'path', value: `${HOME}/.env` });

        expect(resolved.label).toBe('secret');
        expect(resolved.suppressed).toHaveLength(1);
        expect(resolved.suppressed[0]).toMatchObject({
            reason: 'user-downgrade-suppressed',
            userLabel: 'internal',
            enforcedLabel: 'secret',
        });
    });

    it('aggregates suppressed annotations into one notice (B3)', () => {
        const events = [
            ...registry([
                { kind: 'path', pattern: '**/.env', label: 'internal', origin: 'user' },
            ]).resolve({ kind: 'path', value: `${HOME}/.env` }).suppressed,
            ...registry([
                { kind: 'path', pattern: '**/.env', label: 'internal', origin: 'user' },
            ]).resolve({ kind: 'path', value: `${HOME}/.env` }).suppressed,
        ];
        const groups = aggregateSuppressions(events);
        expect(groups).toHaveLength(1);
        expect(groups[0].count).toBe(2);
        expect(formatSuppressionNotice(groups)).toContain('你的 1 条标注未生效');
    });

    it('lets a user raise sensitivity and add boundary (union)', () => {
        const resolved = registry([
            {
                kind: 'path',
                pattern: `${WORKSPACE}/report.txt`,
                label: 'secret',
                boundary: true,
                origin: 'user',
            },
        ]).resolve({ kind: 'path', value: `${WORKSPACE}/report.txt` });
        expect(resolved.label).toBe('secret');
        expect(resolved.boundary).toBe(true);
    });

    it('takes the strictest label when platform sensitive meets a lower user declaration', () => {
        const resolved = registry([
            { kind: 'path', pattern: '**/notes.txt', label: 'public', origin: 'user' },
        ]).resolve({ kind: 'path', value: `${HOME}/notes.txt` });
        expect(resolved.label).toBe('sensitive');
    });
});
