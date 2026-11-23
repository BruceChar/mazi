import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnalysisStack } from '../src/analysis/stack.js';
import { DelegationStack } from '../src/agent/stack.js';
import type { RuntimeConfig } from '../src/config.js';

const config: RuntimeConfig = { providers: [], tools: [] };

describe('DelegationStack', () => {
    it('内置角色可用，注册/移除经栈内注册表，close 释放存储', () => {
        const stack = new DelegationStack(config);
        try {
            expect(stack.listRoles().length).toBeGreaterThan(0);
            stack.roles.register({
                roleId: 'probe',
                label: '探针',
                tools: [],
                systemPrompt: 'x',
                defaultCeiling: 'read-only',
                memoryPolicy: 'inherit',
            });
            expect(stack.listRoles().some((role) => role.roleId === 'probe')).toBe(true);
            expect(stack.roles.remove('probe')).toBe(true);
        } finally {
            stack.close();
        }
    });
});

describe('AnalysisStack', () => {
    it('组合 toc 与 iterations，使用同一 dbPath 并整体释放', () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-stack-'));
        try {
            const stack = new AnalysisStack({
                dbPath: join(dir, 'mazi.db'),
                snapshotOf: async () => ({}) as never,
                requestRound: async () => ({ text: '' }) as never,
                resolveModelChoice: () => undefined,
                systemPrompt: 'toc',
            });
            expect(stack.toc).toBeDefined();
            expect(stack.iterations).toBeDefined();
            stack.close();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
