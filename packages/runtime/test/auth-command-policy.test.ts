import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { authz } from '@mazi/core';
import { describe, expect, it } from 'vitest';

import {
    AUTH_COMMAND_POLICY_FILE,
    loadCommandPolicy,
    renderDefaultCommandPolicy,
    validateCommandPolicy,
    writeDefaultCommandPolicy,
} from '../src/auth/command-policy.js';
import { maziPaths } from '../src/paths.js';

function tempFile(): string {
    return join(mkdtempSync(join(tmpdir(), 'mazi-auth-')), AUTH_COMMAND_POLICY_FILE);
}

describe('auth command policy', () => {
    it('falls back to the built-in default when the file is missing (read-only load)', () => {
        const file = tempFile();
        const loaded = loadCommandPolicy(file);
        expect(loaded.source).toBe('default');
        expect(existsSync(file)).toBe(false);
        const rules = authz.compileCommandPolicy(loaded.policy);
        expect(authz.classifyCommand('git status', rules)).toBe('readonly');
        expect(authz.classifyCommand('git reset --hard', rules)).toBe('dangerous');
        expect(authz.classifyCommand('ping baidu.com', rules)).toBe('readonly');
        expect(authz.classifyCommand('curl https://x', rules)).toBe('network');
        expect(authz.classifyCommand('mycmd --x', rules)).toBe('unknown');
    });

    it('writes the default template on demand and loads it back', () => {
        const file = tempFile();
        writeDefaultCommandPolicy(file);
        expect(existsSync(file)).toBe(true);
        const loaded = loadCommandPolicy(file);
        expect(loaded.source).toBe('file');
        const rules = authz.compileCommandPolicy(loaded.policy);
        expect(authz.classifyCommand('git log', rules)).toBe('readonly');
    });

    it('merges a config file over defaults (arrays replace, subcommands per key)', () => {
        const file = tempFile();
        writeFileSync(
            file,
            JSON.stringify({
                dangerousHeads: ['mycmd'],
                subcommands: { git: ['status'] },
            }),
        );
        const loaded = loadCommandPolicy(file);
        expect(loaded.source).toBe('file');
        const rules = authz.compileCommandPolicy(loaded.policy);
        expect(authz.classifyCommand('mycmd x', rules)).toBe('dangerous');
        // dangerousHeads 被整段替换：rm 不再危险，无规则 → shell.run 默认
        expect(authz.classifyCommand('rm -rf x', rules)).toBe('unknown');
        expect(authz.classifyCommand('git status', rules)).toBe('readonly');
        // git 子命令被替换为仅 status：log 归 dangerous
        expect(authz.classifyCommand('git log', rules)).toBe('dangerous');
    });

    it('falls back to defaults on invalid JSON', () => {
        const file = tempFile();
        writeFileSync(file, '{ not json');
        const loaded = loadCommandPolicy(file);
        expect(loaded.source).toBe('default');
        expect(loaded.error).toBeDefined();
    });

    it('strictly validates known fields (typos must not silently weaken rules)', () => {
        expect(validateCommandPolicy({ dangerousHeads: ['rm'] }).ok).toBe(true);
        expect(validateCommandPolicy({ dangerousHeads: 'rm' }).ok).toBe(false);
        expect(validateCommandPolicy({ subcommands: { git: 'status' } }).ok).toBe(false);
        expect(validateCommandPolicy({ subcommands: { git: ['status'] } }).ok).toBe(true);
        expect(validateCommandPolicy([]).ok).toBe(false);
        expect(validateCommandPolicy({ readonlyHeads: ['ping'] }).ok).toBe(true);
    });

    it('upgrades a legacy file in place, preserving user rules', () => {
        const file = tempFile();
        writeFileSync(file, JSON.stringify({ dangerousHeads: ['mycmd'] }));
        writeDefaultCommandPolicy(file);
        const upgraded = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
        expect(upgraded.$schema).toBe('./commands.schema.json');
        expect(typeof upgraded._doc).toBe('object');
        expect(upgraded.dangerousHeads).toEqual(['mycmd']);
    });

    it('renders a self-documenting default template with $schema/version/_doc', () => {
        const parsed = JSON.parse(renderDefaultCommandPolicy()) as Record<string, unknown>;
        expect(parsed.$schema).toBe('./commands.schema.json');
        expect(parsed.version).toBe(1);
        expect(typeof parsed._doc).toBe('object');
        expect(Array.isArray(parsed.dangerousHeads)).toBe(true);
        expect((parsed._doc as Record<string, string>).subcommands).toContain('只读');
    });

    it('honors MAZI_AUTH_CONFIG_DIR for the default path', () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-auth-dir-'));
        const previous = process.env.MAZI_AUTH_CONFIG_DIR;
        process.env.MAZI_AUTH_CONFIG_DIR = dir;
        try {
            const paths = maziPaths();
            expect(paths.authConfigDir).toBe(dir);
            expect(paths.authCommandPolicyFile).toBe(join(dir, AUTH_COMMAND_POLICY_FILE));
        } finally {
            if (previous === undefined) delete process.env.MAZI_AUTH_CONFIG_DIR;
            else process.env.MAZI_AUTH_CONFIG_DIR = previous;
        }
    });
});
