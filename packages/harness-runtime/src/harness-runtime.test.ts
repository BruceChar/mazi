import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RuntimeConfig } from './config.js';
import { HarnessRuntime } from './runtime.js';

function cfg(): RuntimeConfig {
    return {
        providers: [
            {
                id: 'scripted-a',
                vendor: 'scripted',
                tags: ['tools'],
                models: [
                    {
                        id: 'm',
                        contextWindow: 64000,
                        supportsTools: true,
                        supportsThinking: true,
                        supportsVision: false,
                    },
                ],
                driver: {
                    type: 'scripted',
                    rounds: [
                        {
                            toolCalls: [
                                {
                                    callId: 'c',
                                    toolName: 'fs.read',
                                    arguments: { path: 'README.md' },
                                },
                            ],
                            usage: { inputTokens: 10, outputTokens: 5, reportedByVendor: true },
                        },
                        {
                            text: '完成。',
                            usage: { inputTokens: 6, outputTokens: 4, reportedByVendor: true },
                        },
                    ],
                },
                pricing: {
                    currency: 'USD',
                    base: { inputPerMTok: 0.5, outputPerMTok: 1.5 },
                    tiers: [],
                    effectiveAt: 0,
                    version: 't',
                },
                health: { score: 1 },
            },
        ],
        tools: [
            {
                name: 'fs.read',
                description: '读',
                parameters: {
                    type: 'object',
                    properties: { path: { type: 'string' } },
                    required: ['path'],
                },
                minPermission: 'read-only',
                irreversible: false,
                sideEffects: ['fs'],
            },
        ],
        goal: {
            allowedTools: ['fs.read'],
            requiredTools: [{ nameOrCapability: 'fs.read', required: true }],
            maxSteps: 6,
            permissionCeiling: 'read-only',
        },
        dbPath: ':memory:',
        eventDir: mkdtempSync(join(tmpdir(), 'mazi-rte-')),
        consoleEnabled: false,
    };
}

describe('createSession / executeSession（run 兼容）', () => {
    it('createSession 立即生成 recording 会话；executeSession 完成并写 outcome', async () => {
        const rt = new HarnessRuntime(cfg());
        const created = await rt.createSession('读取 README.md', { userId: 'u' });
        expect(created.sessionId.length).toBeGreaterThan(0);
        const before = await rt.getRecord(created.sessionId);
        expect(before?.status).toBe('recording');
        const result = await rt.executeSession(created.sessionId);
        expect(result.outcome).toBe('success');
        const after = await rt.getRecord(created.sessionId);
        expect(after?.status).toBe('completed');
        expect(after?.outcome?.status).toBe('success');
        await rt.close();
    });

    it('重复执行已结束会话抛错', async () => {
        const rt = new HarnessRuntime(cfg());
        const created = await rt.createSession('读取 README.md');
        await rt.executeSession(created.sessionId);
        await expect(rt.executeSession(created.sessionId)).rejects.toThrow(/已结束/);
        await rt.close();
    });

    it('run 与 create+execute 等价（向后兼容）', async () => {
        const rt = new HarnessRuntime(cfg());
        const a = await rt.run('读取 README.md');
        const created = await rt.createSession('读取 README.md');
        const b = await rt.executeSession(created.sessionId);
        expect(a.outcome).toBe(b.outcome);
        expect(a.sessionId).not.toBe(b.sessionId);
        await rt.close();
    });
});
