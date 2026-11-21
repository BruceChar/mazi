import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
    HarnessEvent,
    LLMProvider,
    LLMRequest,
    StreamCompletionEvent,
} from '@mazi/core';
import { sessionStreamId } from '@mazi/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { HarnessRuntime } from '../src/harness/index.js';

const dirs: string[] = [];

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runtimeConfig(dir: string): RuntimeConfig {
    return {
        providers: [],
        tools: [],
        dbPath: ':memory:',
        eventDir: dir,
        goal: { permissionCeiling: 'read-only' },
        contextWindow: 64000,
        wiki: { enabled: false },
    };
}

const SINGLE_TASK = [
    { key: 'execute', title: '执行方案 A', dependsOn: [], requiredTools: [] },
];

function readEvents(dir: string, rootGoalId: string): HarnessEvent[] {
    return readFileSync(join(dir, `${rootGoalId}.jsonl`), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as HarnessEvent);
}

function capturingProvider(systems: string[]): LLMProvider {
    return {
        id: 'fake',
        name: 'fake',
        defaultModel: 'fake-model',
        models: [],
        async ask() {
            throw new Error('ask unused');
        },
        async *askStream(request: LLMRequest): AsyncIterable<StreamCompletionEvent> {
            systems.push(request.system ?? '');
            yield { type: 'start', model: 'fake-model' };
            yield { type: 'text_delta', text: '任务完成。' };
            yield { type: 'finish', finishReason: 'stop' };
        },
    };
}

describe('HarnessRuntime × 会话/轮次生命周期（§3.3）', () => {
    it('会话首轮发 session.started；轮次发 turn.started/ended 并带 sessionId', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-lifecycle-'));
        dirs.push(dir);
        const systems: string[] = [];
        const runtime = new HarnessRuntime(runtimeConfig(dir), {
            llmProviders: { fake: capturingProvider(systems) },
            workspaceRoot: dir,
            taskPlanner: async () => SINGLE_TASK,
        });
        const off = runtime.hooks.register({
            id: 'memory-inject',
            point: 'turn.start',
            handle: () => ({ kind: 'patch', patch: { contextAppend: 'MEMORY_MARKER' } }),
        });
        try {
            const created = await runtime.createGoalSession('执行一个任务', {
                conversationId: 'conv-life-1',
                taskPlanning: true,
            });
            await runtime.executeGoalTree(created.rootGoalId);

            const events = readEvents(dir, created.rootGoalId);
            const types = events.map((event) => event.type);
            expect(types).toContain('turn.started');
            expect(types).toContain('turn.ended');
            expect(types).toContain('hook.patch');
            for (const event of events) {
                expect(event.sessionId).toBe('conv-life-1');
            }
            const ended = events.find((event) => event.type === 'turn.ended');
            expect(ended?.payload).toMatchObject({ ok: true, tasks: 1 });

            // turn.start 的 patch 进入后续模型上下文（钩子能真正影响执行）。
            expect(systems.some((system) => system.includes('MEMORY_MARKER'))).toBe(true);

            const sessionFile = join(dir, `${sessionStreamId('conv-life-1')}.jsonl`);
            expect(existsSync(sessionFile)).toBe(true);
            const sessionEvents = readFileSync(sessionFile, 'utf8')
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line) as HarnessEvent);
            expect(sessionEvents.map((event) => event.type)).toEqual(['session.started']);
            expect(sessionEvents[0]?.sessionId).toBe('conv-life-1');
            off();
        } finally {
            await runtime.close();
        }
    });

    it('endSession 落 session.ended，replaySession 能合并回放整段会话', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-lifecycle-'));
        dirs.push(dir);
        const runtime = new HarnessRuntime(runtimeConfig(dir), {
            llmProviders: { fake: capturingProvider([]) },
            workspaceRoot: dir,
            taskPlanner: async () => SINGLE_TASK,
        });
        const ended: string[] = [];
        runtime.hooks.register({
            id: 'memory-write',
            point: 'session.end',
            handle: () => {
                ended.push('written');
                return { kind: 'continue' };
            },
        });
        try {
            const created = await runtime.createGoalSession('执行一个任务', {
                conversationId: 'conv-life-2',
                taskPlanning: true,
            });
            await runtime.executeGoalTree(created.rootGoalId);
            await runtime.endSession('conv-life-2', 'test-close');
            expect(ended).toEqual(['written']);

            const replay = (
                runtime.eventBus as unknown as {
                    replaySession(sessionId: string): HarnessEvent[];
                }
            ).replaySession('conv-life-2');
            const types = replay.map((event) => event.type);
            expect(types[0]).toBe('session.started');
            expect(types.at(-1)).toBe('session.ended');
            expect(types).toContain('turn.started');
            expect(types).toContain('turn.ended');
            expect(types).toContain('hook.invoked');
            expect(replay.at(-1)?.payload).toMatchObject({ reason: 'test-close' });
            // 回放顺序按 timestamp 单调；同一时间戳按 seq 稳定。
            const stamps = replay.map((event) => event.timestamp);
            expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
        } finally {
            await runtime.close();
        }
    });
});
