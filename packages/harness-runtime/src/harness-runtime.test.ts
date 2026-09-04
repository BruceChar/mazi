import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from './config.js';
import { HarnessRuntime } from './runtime.js';

const dirs: string[] = [];

function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), 'mazi-rt-'));
    dirs.push(d);
    return d;
}

afterEach(() => {
    // 交由系统临时目录回收
    void dirs.splice(0);
});

function runtimeConfig(over: Partial<RuntimeConfig> = {}): {
    config: RuntimeConfig;
    fixture: string;
    eventDir: string;
} {
    const base = tmp();
    const eventDir = join(base, 'events');
    const fixture = join(base, 'data.txt');
    writeFileSync(fixture, 'HELLO FROM FIXTURE', 'utf8');
    const config: RuntimeConfig = {
        providers: [
            {
                id: 'scripted-a',
                vendor: 'scripted',
                tags: ['tools'],
                models: [
                    {
                        id: 'scripted-1',
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
                            reasoning: '先读取文件',
                            toolCalls: [
                                { callId: 'c1', toolName: 'fs.read', arguments: { path: fixture } },
                            ],
                            usage: { inputTokens: 60, outputTokens: 10, reportedByVendor: true },
                        },
                        {
                            text: '已读取并完成任务。',
                            usage: { inputTokens: 40, outputTokens: 15, reportedByVendor: true },
                        },
                    ],
                },
                pricing: {
                    currency: 'USD',
                    base: { inputPerMTok: 0.5, outputPerMTok: 1.5 },
                    tiers: [],
                    effectiveAt: 0,
                    version: '0.0.0-test',
                },
                health: { score: 1 },
            },
        ],
        tools: [
            {
                name: 'fs.read',
                description: '读取文件',
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
            permissionCeiling: 'read-only',
            allowedTools: ['fs.read'],
            requiredTools: [{ nameOrCapability: 'fs.read', required: true }],
            maxSteps: 8,
            maxCostUsd: 1,
        },
        eventDir,
        dbPath: join(base, 'store.db'),
        contextWindow: 64000,
        consoleEnabled: false,
        ...over,
    };
    return { config, fixture, eventDir };
}

describe('HarnessRuntime（MVP v1.0 §8 F14 / 验收 A12 A13）', () => {
    it('run(input) 全流程：session→goal→plan→capacity→执行→session.ended；事件落盘、用户记录 completed', async () => {
        const { config, eventDir } = runtimeConfig();
        const runtime = new HarnessRuntime(config);
        const result = await runtime.run('读取文件并汇报', { userId: 'u-rt' });
        expect(result.outcome).toBe('success');
        expect(result.summary).toContain('已读取');
        expect(result.turnCount).toBe(1);
        expect(result.totalTokens).toBeGreaterThan(0);
        expect(result.totalCostUsd).toBeGreaterThan(0);
        // 用户交互记录：创建→completed，含原始输入与 metrics
        const record = result.record;
        expect(record?.status).toBe('completed');
        expect(record?.rawInput).toBe('读取文件并汇报');
        expect(record?.userId).toBe('u-rt');
        expect(record?.metrics.totalCostUsd).toBeGreaterThan(0);
        // 事件 JSONL 持久化且关键事件齐全
        const file = join(eventDir, `${result.sessionId}.jsonl`);
        expect(existsSync(file)).toBe(true);
        const lines = readFileSync(file, 'utf8').trim().split('\n');
        const types = lines.map((l) => (JSON.parse(l) as { type: string }).type);
        for (const t of [
            'session.started',
            'plan.created',
            'provider.selected',
            'llm.request',
            'tool.invoke',
            'session.ended',
            'user.input.recorded',
        ]) {
            expect(types).toContain(t);
        }
        await runtime.close();
    });

    it('recordFeedback 追加到用户记录', async () => {
        const { config } = runtimeConfig();
        const runtime = new HarnessRuntime(config);
        const result = await runtime.run('任务', { userId: 'u2' });
        runtime.recordFeedback(result.sessionId, {
            timestamp: Date.now(),
            type: 'output_rating',
            rating: 5,
            content: '很棒',
        });
        // 异步订阅更新
        await new Promise((resolve) => setTimeout(resolve, 30));
        const record = await runtime.getRecord(result.sessionId);
        expect(record?.feedback).toHaveLength(1);
        expect(record?.feedback[0]?.rating).toBe(5);
        await runtime.close();
    });

    it('Policy 拦截路径：driver 请求白名单外工具 → outcome failed，工具未执行', async () => {
        const { config, eventDir } = runtimeConfig();
        const evil = JSON.parse(JSON.stringify(config)) as RuntimeConfig;
        const provider = evil.providers[0];
        if (!provider?.driver) {
            throw new Error('no provider');
        }
        provider.driver.rounds = [
            {
                toolCalls: [
                    { callId: 'evil', toolName: 'fs.write', arguments: { path: '/tmp/x' } },
                ],
                usage: { inputTokens: 10, outputTokens: 5, reportedByVendor: true },
            },
        ];
        const runtime = new HarnessRuntime(evil);
        const result = await runtime.run('任务');
        expect(result.outcome).toBe('failed');
        const file = join(eventDir, `${result.sessionId}.jsonl`);
        const lines = readFileSync(file, 'utf8').trim().split('\n');
        const types = lines.map((l) => (JSON.parse(l) as { type: string }).type);
        expect(types).toContain('tool.blocked');
        await runtime.close();
    });

    it('事件目录文件按 session 隔离；无 providers 之外默认不落库', async () => {
        const { config } = runtimeConfig();
        const runtime = new HarnessRuntime(config);
        const a = await runtime.run('任务一', { userId: 'u1' });
        const b = await runtime.run('任务二', { userId: 'u2' });
        expect(a.sessionId).not.toBe(b.sessionId);
        const dir = config.eventDir as string;
        expect(readdirSync(dir).sort()).toEqual(
            [`${a.sessionId}.jsonl`, `${b.sessionId}.jsonl`].sort(),
        );
        await runtime.close();
    });
});
