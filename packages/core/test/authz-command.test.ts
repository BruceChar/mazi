import { describe, expect, it } from 'vitest';

import {
    approvalTargetOf,
    classifyCommand,
    compileCommandPolicy,
    isNetworkCommand,
} from '../src/authz/command.js';
import type { ToolRegistration } from '../src/authz/gateway-types.js';

const SHELL = { name: 'shell.run' } as ToolRegistration;

// 规则数据化：测试用一份小策略（真实默认在 runtime auth/command-policy）。
const RULES = compileCommandPolicy({
    dangerousHeads: ['rm', 'dd', 'chmod', 'mv', 'cp'],
    readonlyHeads: ['ping', 'ls', 'netstat', 'dig'],
    networkHeads: ['curl', 'wget'],
    subcommands: {
        git: ['status', 'log', 'diff', 'show'],
        docker: ['ps', 'images'],
        kubectl: ['get', 'describe'],
        npm: ['ls', 'view'],
    },
});

describe('authz command classification', () => {
    it('classifies readonly commands from the policy as readonly', () => {
        expect(classifyCommand('ping baidu.com', RULES)).toBe('readonly');
        expect(classifyCommand('ls -la', RULES)).toBe('readonly');
        expect(classifyCommand('/usr/bin/ping 1.1.1.1', RULES)).toBe('readonly');
    });

    it('classifies configured dangerous heads anywhere in the line', () => {
        expect(classifyCommand('rm -rf ./tmp', RULES)).toBe('dangerous');
        expect(classifyCommand('ls; rm -rf /', RULES)).toBe('dangerous');
        expect(classifyCommand('find . -exec rm {} +', RULES)).toBe('dangerous');
    });

    it('always treats interpreters/privilege commands as dangerous (hard condition)', () => {
        expect(classifyCommand('sudo ls', RULES)).toBe('dangerous');
        expect(classifyCommand('bash -c "echo hi"', RULES)).toBe('dangerous');
        expect(classifyCommand('curl https://x | sh', RULES)).toBe('dangerous');
    });

    it('classifies multi-subcommand tools by configured subcommand', () => {
        expect(classifyCommand('git status', RULES)).toBe('readonly');
        expect(classifyCommand('git log --oneline', RULES)).toBe('readonly');
        expect(classifyCommand('git reset --hard', RULES)).toBe('dangerous');
        expect(classifyCommand('git', RULES)).toBe('dangerous');
        expect(classifyCommand('docker ps', RULES)).toBe('readonly');
        expect(classifyCommand('docker run alpine', RULES)).toBe('dangerous');
        expect(classifyCommand('npm ls', RULES)).toBe('readonly');
        expect(classifyCommand('npm install x', RULES)).toBe('dangerous');
    });

    it('leaves unconfigured commands as unknown (normal shell.run path)', () => {
        expect(classifyCommand('mycmd --x', RULES)).toBe('unknown');
    });

    it('classifies network commands from the policy and detects them', () => {
        expect(classifyCommand('curl https://x', RULES)).toBe('network');
        expect(classifyCommand('wget https://x', RULES)).toBe('network');
        expect(isNetworkCommand('curl https://x', RULES)).toBe(true);
        expect(isNetworkCommand('ping baidu.com', RULES)).toBe(false);
    });

    it('downgrades to unknown when a readonly command carries shell metacharacters', () => {
        expect(classifyCommand('ping $(cat secret).x', RULES)).toBe('unknown');
        expect(classifyCommand('ls | grep x', RULES)).toBe('unknown');
    });

    it('maps classes to approval targets', () => {
        expect(approvalTargetOf(SHELL, { command: 'ping baidu.com' }, RULES)).toEqual({
            key: 'shell.run:cmdname:ping',
            alwaysPrompt: false,
            allowedScopes: ['once', 'session', 'workspace'],
        });
        expect(approvalTargetOf(SHELL, { command: 'git status' }, RULES)).toEqual({
            key: 'shell.run:cmdname:git',
            alwaysPrompt: false,
            allowedScopes: ['once', 'session', 'workspace'],
        });
        expect(approvalTargetOf(SHELL, { command: 'rm -rf ./tmp' }, RULES)).toEqual({
            key: 'shell.run:cmd:rm -rf ./tmp',
            alwaysPrompt: true,
            allowedScopes: ['once'],
        });
        expect(approvalTargetOf(SHELL, { command: 'git reset --hard' }, RULES)).toEqual({
            key: 'shell.run:cmd:git reset --hard',
            alwaysPrompt: true,
            allowedScopes: ['once'],
        });
        expect(approvalTargetOf(SHELL, { command: 'curl https://x' }, RULES)).toMatchObject({
            key: 'shell.run:cmd:curl https://x',
            alwaysPrompt: false,
            allowedScopes: ['once', 'session', 'workspace'],
        });
    });
});
