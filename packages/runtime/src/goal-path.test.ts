import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
    LLMProvider,
    LLMRequest,
    LLMResponse,
    ProviderModel,
    StreamCompletionEvent,
} from '@mazi/core';
import { describe, expect, it } from 'vitest';
import type { RuntimeConfig } from './config.js';
import { HarnessRuntime } from './runtime.js';

class OfflineProvider implements LLMProvider {
    id = 'p';
    name = 'offline';
    defaultModel = 'm';
    models: ProviderModel[] = [];
    async ask(_request: LLMRequest): Promise<LLMResponse> {
        return { model: 'm', content: [{ type: 'text', text: '完成。' }], finishReason: 'stop' };
    }
    async *askStream(_request: LLMRequest): AsyncIterable<StreamCompletionEvent> {
        yield { type: 'text_delta', text: '完成。' };
        yield { type: 'finish', finishReason: 'stop' };
    }
}

function cfg(): RuntimeConfig {
    return {
        providers: [],
        tools: [],
        goal: { allowedTools: [], requiredTools: [], maxSteps: 2 },
        dbPath: ':memory:',
        eventDir: mkdtempSync(join(tmpdir(), 'mazi-goalpath-')),
        consoleEnabled: false,
    };
}

describe('HarnessRuntime Goal 路径（C3e，与旧 Session 路径共存）', () => {
    it('createGoalSession + executeGoalTree：intake→work→Task 执行成功', async () => {
        const rt = new HarnessRuntime(cfg(), { llmProviders: { p: new OfflineProvider() } });
        try {
            const created = await rt.createGoalSession('读取 README 并汇报');
            expect(created.goalId.length).toBeGreaterThan(0);
            const result = await rt.executeGoalTree(created.rootGoalId);
            expect(result.ok).toBe(true);
            expect(result.tasks).toHaveLength(1);
            expect(result.tasks[0]?.ok).toBe(true);
            expect(result.tasks[0]?.finalMessage).toContain('完成');
            const snap = await rt.goalSnapshot(created.rootGoalId);
            expect(snap.rootGoalId).toBe(created.rootGoalId);
            expect(snap.taskCount).toBe(1);
            expect(snap.stepCount).toBe(1);
            expect(
                snap.goals.find((g) => g.goalId === created.goalId)?.tasks[0]?.steps,
            ).toHaveLength(1);
        } finally {
            await rt.close();
        }
    });

    it('Goal 会话事件：createGoalSession 发 session.started；executeGoalTree 发 session.ended（sessionId=rootGoalId）', async () => {
        const rt = new HarnessRuntime(cfg(), { llmProviders: { p: new OfflineProvider() } });
        try {
            const created = await rt.createGoalSession('完成');
            const started = rt.eventBus.replay(created.rootGoalId);
            expect(started.some((e) => e.type === 'session.started')).toBe(true);
            await rt.executeGoalTree(created.rootGoalId);
            const all = rt.eventBus.replay(created.rootGoalId);
            expect(all.some((e) => e.type === 'session.ended')).toBe(true);
            const ended = all.find((e) => e.type === 'session.ended');
            const payload = ended?.payload as { outcome?: { status?: string } } | undefined;
            expect(payload?.outcome?.status).toBe('success');
        } finally {
            await rt.close();
        }
    });
});

class ToolProvider implements LLMProvider {
    id = 'p';
    name = 'tools';
    defaultModel = 'm';
    models: ProviderModel[] = [];
    private round = 0;
    constructor(private readonly filePath: string) {}
    async ask(_request: LLMRequest): Promise<LLMResponse> {
        return this.round === 0
            ? { model: 'm', content: [], finishReason: 'stop' }
            : { model: 'm', content: [], finishReason: 'stop' };
    }
    async *askStream(_request: LLMRequest): AsyncIterable<StreamCompletionEvent> {
        this.round += 1;
        if (this.round === 1) {
            yield { type: 'tool_call_start', index: 0, callId: 'c1', name: 'fs.read' };
            yield {
                type: 'tool_call_delta',
                index: 0,
                argumentsDelta: JSON.stringify({ path: this.filePath }),
            };
            yield { type: 'tool_call_stop', index: 0 };
            yield { type: 'finish', finishReason: 'tool_calls' };
            return;
        }
        yield { type: 'text_delta', text: '已读取文件内容。' };
        yield { type: 'finish', finishReason: 'stop' };
    }
}

function toolCfg(): RuntimeConfig {
    return {
        providers: [],
        tools: [
            {
                name: 'fs.read',
                description: '读文件',
                parameters: {
                    type: 'object',
                    properties: { path: { type: 'string' } },
                    required: ['path'],
                },
                minPermission: 'read-only',
                sideEffects: [],
            },
        ],
        goal: { allowedTools: ['fs.read'], maxSteps: 6 },
        dbPath: ':memory:',
        eventDir: mkdtempSync(join(tmpdir(), 'mazi-goalpath-')),
        consoleEnabled: false,
    };
}

describe('HarnessRuntime Goal 工具闭环（C5-1 运行时装配）', () => {
    it('tool_call → fs.read → 观察 → 最终回答；事件落盘可回放', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-goalfile-'));
        const file = join(dir, 'a.txt');
        writeFileSync(file, 'HELLO');
        const rt = new HarnessRuntime(toolCfg(), {
            llmProviders: { p: new ToolProvider(file) },
        });
        try {
            const created = await rt.createGoalSession('读取 a.txt 并汇报');
            const result = await rt.executeGoalTree(created.rootGoalId);
            expect(result.ok).toBe(true);
            expect(result.tasks[0]?.ok).toBe(true);
            const snap = await rt.goalSnapshot(created.rootGoalId);
            const kinds = snap.goals.flatMap((g) =>
                g.tasks.flatMap((t) => t.steps.map((s) => s.kind)),
            );
            expect(kinds).toContain('tool_call');
            expect(kinds).toContain('observation');
            const all = rt.eventBus.replay(created.rootGoalId);
            expect(all.some((e) => e.type === 'session.ended')).toBe(true);
        } finally {
            await rt.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
