import { describe, expect, it } from 'vitest';

import { approvalTargetOf, classifyCommand } from '../src/authz/command.js';
import type { ToolRegistration } from '../src/authz/gateway-types.js';

const SHELL = { name: 'shell.run' } as ToolRegistration;

describe('authz command classification', () => {
    it('classifies readonly connectivity/info commands as readonly', () => {
        expect(classifyCommand('ping baidu.com')).toBe('readonly');
        expect(classifyCommand('ls -la')).toBe('readonly');
        expect(classifyCommand('/usr/bin/ping 1.1.1.1')).toBe('readonly');
    });

    it('classifies destructive or exec commands as dangerous anywhere in the line', () => {
        expect(classifyCommand('rm -rf ./tmp')).toBe('dangerous');
        expect(classifyCommand('ls; rm -rf /')).toBe('dangerous');
        expect(classifyCommand('find . -exec rm {} +')).toBe('dangerous');
        expect(classifyCommand('curl https://x')).toBe('dangerous');
        expect(classifyCommand('sudo ls')).toBe('dangerous');
    });

    it('downgrades to unknown when a readonly command carries shell metacharacters', () => {
        expect(classifyCommand('ping $(cat secret).x')).toBe('unknown');
        expect(classifyCommand('ls | grep x')).toBe('unknown');
    });

    it('maps classes to approval targets', () => {
        expect(approvalTargetOf(SHELL, { command: 'ping baidu.com' })).toEqual({
            key: 'shell.run:cmdname:ping',
            alwaysPrompt: false,
            allowedScopes: ['once', 'session', 'workspace'],
        });
        expect(approvalTargetOf(SHELL, { command: 'rm -rf ./tmp' })).toEqual({
            key: 'shell.run:cmd:rm -rf ./tmp',
            alwaysPrompt: true,
            allowedScopes: ['once'],
        });
        expect(approvalTargetOf(SHELL, { command: 'ls | grep x' })).toMatchObject({
            key: 'shell.run:cmd:ls | grep x',
            alwaysPrompt: false,
            allowedScopes: ['once', 'session', 'workspace'],
        });
    });
});
