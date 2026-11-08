import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessEvent, LLMProvider, LLMRequest, StreamCompletionEvent } from '@mazi/core';
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

function textOf(request: LLMRequest): string {
    return [
        request.system ?? '',
        ...request.messages
            .flatMap((message) => message.content)
            .filter((block) => block.type === 'text')
            .map((block) => block.text),
    ].join('\n');
}

/** 普通轮次（非 triage/规划）的回复：让 Task 执行能正常收尾。 */
function plainProvider(): LLMProvider {
    return {
        id: 'fake',
        name: 'fake',
        defaultModel: 'fake-model',
        models: [],
        async ask() {
            throw new Error('ask unused');
        },
        async *askStream(): AsyncIterable<StreamCompletionEvent> {
            yield { type: 'start', model: 'fake-model' };
            yield { type: 'text_delta', text: '阶段完成。' };
            yield { type: 'finish', finishReason: 'stop' };
        },
    };
}

/**
 * triage 轮次会先等 gate 放行：用于证明 intake 事件在 triage 真正返回之前就已发出，
 * 且不会等模型（不产生真实网络调用）。
 */
function gatedTriageProvider(plan: unknown): { provider: LLMProvider; release: () => void } {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const provider: LLMProvider = {
        id: 'fake',
        name: 'fake',
        defaultModel: 'fake-model',
        models: [],
        async ask() {
            throw new Error('ask unused');
        },
        async *askStream(request: LLMRequest): AsyncIterable<StreamCompletionEvent> {
            const isTriage = textOf(request).includes('intent triage layer');
            if (isTriage) await gate;
            yield { type: 'start', model: 'fake-model' };
            yield { type: 'text_delta', text: isTriage ? JSON.stringify(plan) : '阶段完成。' };
            yield { type: 'finish', finishReason: 'stop' };
        },
    };
    return { provider, release };
}

const SINGLE_TASK = [
    {
        key: 'execute',
        title: '执行方案 A',
        dependsOn: [],
        requiredTools: [],
    },
];

function readEvents(dir: string, rootGoalId: string): HarnessEvent[] {
    return readFileSync(join(dir, `${rootGoalId}.jsonl`), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as HarnessEvent);
}

interface PhasePayload {
    phase: string;
    label?: string;
}

function phasePayloads(events: HarnessEvent[]): PhasePayload[] {
    return events
        .filter((event) => event.type === 'goal.phase')
        .map((event) => event.payload as PhasePayload);
}

describe('HarnessRuntime × goal.phase（执行前置阶段可观测）', () => {
    it('createGoalSession(parseIntent) 在 triage 返回之前同步发出 goal.phase intake', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-phase-intake-'));
        dirs.push(dir);
        const { provider, release } = gatedTriageProvider({ blocks: [] });
        const runtime = new HarnessRuntime(runtimeConfig(dir), {
            llmProviders: { fake: provider },
            workspaceRoot: dir,
        });
        try {
            const created = await runtime.createGoalSession('把这个项目整理一下', {
                parseIntent: true,
                taskPlanning: false,
            });
            // triage 仍被 gate 挡住；intake 事件在创建返回前已 emit + flush（可被 SSE 回放）。
            const events = readEvents(dir, created.rootGoalId);
            expect(events.map((event) => event.type)).toEqual(['goal.started', 'goal.phase']);
            const phase = events.at(-1);
            expect(phase?.payload).toEqual({ phase: 'intake', label: '正在理解任务' });
            // goal 级事件：只有 rootGoalId + goalId，没有 taskId/stepId。
            expect(phase?.rootGoalId).toBe(created.rootGoalId);
            expect(phase?.goalId).toBe(created.rootGoalId);
            expect(phase?.taskId).toBeUndefined();
            expect(phase?.stepId).toBeUndefined();
            release();
            await runtime.executeGoalTree(created.rootGoalId);
        } finally {
            await runtime.close();
        }
    });

    it('executeGoalTree 发出 planning → executing，且都先于 plan.created / step.started', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-phase-plan-'));
        dirs.push(dir);
        const runtime = new HarnessRuntime(runtimeConfig(dir), {
            llmProviders: { fake: plainProvider() },
            workspaceRoot: dir,
            taskPlanner: async () => SINGLE_TASK,
        });
        try {
            const created = await runtime.createGoalSession('执行一个任务', {
                taskPlanning: true,
            });
            await runtime.executeGoalTree(created.rootGoalId);
            const events = readEvents(dir, created.rootGoalId);
            const types = events.map((event) => event.type);
            const phases = phasePayloads(events);
            expect(phases.map((payload) => payload.phase)).toEqual(['planning', 'executing']);
            expect(phases[0]?.label).toBe('正在制定计划');
            expect(phases[1]?.label).toBe('正在执行');

            const planningAt = types.indexOf('goal.phase');
            const executingAt = types.indexOf('goal.phase', planningAt + 1);
            const planCreatedAt = types.indexOf('plan.created');
            const firstStepAt = types.findIndex((type) => type === 'step.started');
            expect(planCreatedAt).toBeGreaterThan(-1);
            // 阶段事件必须早于它所指的工作：planning 在生成计划前，executing 在执行前。
            expect(planningAt).toBeLessThan(planCreatedAt);
            expect(executingAt).toBeLessThan(planCreatedAt);
            if (firstStepAt >= 0) {
                expect(executingAt).toBeLessThan(firstStepAt);
            }

            const planningEvent = events[planningAt];
            expect(planningEvent?.goalId).toBe(created.rootGoalId);
            expect(planningEvent?.taskId).toBeUndefined();
            expect(planningEvent?.stepId).toBeUndefined();
        } finally {
            await runtime.close();
        }
    });

    it('跳过规划时直接发 executing（不产生 planning）', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-phase-skip-'));
        dirs.push(dir);
        const runtime = new HarnessRuntime(runtimeConfig(dir), {
            llmProviders: { fake: plainProvider() },
            workspaceRoot: dir,
        });
        try {
            const created = await runtime.createGoalSession('直接回答', { taskPlanning: false });
            await runtime.executeGoalTree(created.rootGoalId);
            const events = readEvents(dir, created.rootGoalId);
            const phases = phasePayloads(events);
            expect(phases.map((payload) => payload.phase)).toEqual(['executing']);
            const executingAt = events.findIndex((event) => event.type === 'goal.phase');
            const planCreatedAt = events.findIndex((event) => event.type === 'plan.created');
            expect(executingAt).toBeGreaterThan(-1);
            // 单 Task MVP 仍会在执行期产生 plan.created；executing 先于它。
            if (planCreatedAt >= 0) {
                expect(executingAt).toBeLessThan(planCreatedAt);
            }
        } finally {
            await runtime.close();
        }
    });
});
