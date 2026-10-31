import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
    HarnessEvent,
    LLMProvider,
    LLMRequest,
    StreamCompletionEvent,
} from '@mazi/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { HarnessRuntime } from '../src/harness/index.js';

/** 脚本化 provider：按调用顺序返回预置文本（第 1 次 = triage，之后 = 执行轮）。 */
function scriptedProvider(replies: string[]): { provider: LLMProvider; calls: string[] } {
    const calls: string[] = [];
    const pick = (): string => replies[Math.min(calls.length - 1, replies.length - 1)] ?? '';
    const record = (request: LLMRequest): void => {
        calls.push(
            request.messages
                .map((message) =>
                    message.content
                        .map((block) => (block.type === 'text' ? block.text : ''))
                        .join(''),
                )
                .join('\n'),
        );
    };
    const provider: LLMProvider = {
        id: 'default',
        name: 'scripted',
        defaultModel: 'scripted-model',
        models: [],
        async ask(request: LLMRequest) {
            record(request);
            return {
                model: 'scripted-model',
                content: [{ type: 'text', text: pick() }],
                finishReason: 'stop',
            };
        },
        async *askStream(request: LLMRequest): AsyncIterable<StreamCompletionEvent> {
            record(request);
            yield { type: 'text_delta', text: pick() };
            yield { type: 'finish', finishReason: 'stop' };
        },
    };
    return { provider, calls };
}

function configIn(dir: string): RuntimeConfig {
    return {
        providers: [],
        tools: [],
        dbPath: ':memory:',
        eventDir: dir,
        goal: { allowedTools: [] },
        contextWindow: 64000,
        consoleEnabled: false,
    };
}

const negotiateReply = JSON.stringify({
    trace: { classification: 'command', triggers: ['missing information'] },
    blocks: [
        {
            route: 'negotiate',
            understanding: ['用户以为引用了 100 个文件，会话里没有任何文件'],
            defaultPath: ['停止；未识别文件集前不重命名'],
            questions: [{ q: '文件在哪？', why: '没有指称对象', default: '停止' }],
        },
    ],
});

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeRuntime(replies: string[]): { runtime: HarnessRuntime; calls: string[] } {
    const dir = mkdtempSync(join(tmpdir(), 'mazi-negotiate-'));
    dirs.push(dir);
    const scripted = scriptedProvider(replies);
    const runtime = new HarnessRuntime(configIn(dir), {
        llmProviders: { default: scripted.provider },
    });
    return { runtime, calls: scripted.calls };
}

/** 异步 triage 落地：轮询直到 Goal 带上 negotiation（或超时）。 */
async function waitForTriage(runtime: HarnessRuntime, rootGoalId: string): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
        const snap = await runtime.goalSnapshot(rootGoalId);
        if (snap.goals[0]?.negotiation !== undefined) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('triage 未在预期时间内落地');
}

describe('契约协商（triage → 冻结 → 答复修订 → 执行）', () => {
    it('negotiate：默认路径立即执行（回归：协商不得吞掉模型输出），答复后修订契约', async () => {
        const { runtime, calls } = makeRuntime([negotiateReply, '完成。']);
        const observed: HarnessEvent[] = [];
        const unsubscribe = runtime.eventBus.subscribe(
            { types: ['llm.stream_event', 'goal.contract-evaluated'] },
            { id: 'negotiate-observer', handle: (event) => observed.push(event) },
        );
        const streamed = () => observed.filter((event) => event.type === 'llm.stream_event');
        try {
            const created = await runtime.createGoalSession('帮我批量重命名这 100 个文件', {
                parseIntent: true,
            });
            // 创建请求不等 triage：先拿到 Goal + 基线契约（用户消息立刻可见的前提）
            const immediate = await runtime.goalSnapshot(created.rootGoalId);
            expect(immediate.goals[0]?.status).toBe('active');
            expect(immediate.goals[0]?.contract?.successConditions).toHaveLength(2);

            await waitForTriage(runtime, created.rootGoalId);
            expect(calls).toHaveLength(1);

            const before = await runtime.goalSnapshot(created.rootGoalId);
            const goal = before.goals[0];
            // negotiate 不再把 Goal 挂成 blocked：默认路径就是要执行的那条路
            expect(goal?.status).toBe('active');
            expect(goal?.negotiation?.route).toBe('negotiate');
            expect(goal?.negotiation?.classifiedBy).toBe('parser');
            expect(goal?.negotiation?.resolved).toBe(false);
            expect(goal?.negotiation?.triggers).toEqual(['missing information']);
            expect(goal?.negotiation?.questions).toHaveLength(1);
            // 基线 2 条机械条款 + defaultPath 1 条语义条款
            expect(goal?.contract?.successConditions).toHaveLength(3);
            expect(goal?.contract?.deterministicRatio).toBeCloseTo(2 / 3, 6);

            const result = await runtime.executeGoalTree(created.rootGoalId);
            expect(result.ok).toBe(true);
            // 回归断言：主会话流式增量照样到达（此前 negotiate 会整段吞掉输出）
            expect(streamed().length).toBeGreaterThan(0);
            // 契约满足度作为一等事件落库（评估器口径，可回放审计）
            const evaluation = observed.find((event) => event.type === 'goal.contract-evaluated');
            expect(evaluation?.payload).toMatchObject({
                state: 'partial',
                total: 3,
                evaluated: 2,
                failed: 0,
            });
            const done = await runtime.goalSnapshot(created.rootGoalId);
            const task = done.goals[0]?.tasks[0];
            expect(task?.status).toBe('succeeded');
            expect(task?.acceptanceResult?.total).toBe(3);
            expect(task?.acceptanceResult?.evaluated).toBe(2);

            // 事后答复：手写答案升格为条款，契约版本 +1
            const revised = await runtime.negotiateGoal(created.rootGoalId, [
                { q: '文件在哪？', answer: '在 ~/Downloads/photos，只改 IMG_*.jpg' },
            ]);
            expect(revised.revision).toBe(1);
            expect(revised.resolved).toBe(true);
            const after = await runtime.goalSnapshot(created.rootGoalId);
            const goalAfter = after.goals[0];
            expect(goalAfter?.contract?.successConditions).toHaveLength(4);
            expect(goalAfter?.contract?.successConditions.at(-1)?.description).toBe(
                '在 ~/Downloads/photos，只改 IMG_*.jpg',
            );
            expect(goalAfter?.negotiation?.answers[0]?.answer).toBe(
                '在 ~/Downloads/photos，只改 IMG_*.jpg',
            );
        } finally {
            unsubscribe();
            await runtime.close();
        }
    });

    it('创建请求不等 triage：解析模型卡住时，会话创建照常立刻返回', async () => {
        let releaseTriage: (() => void) | undefined;
        const triageGate = new Promise<void>((resolve) => {
            releaseTriage = resolve;
        });
        const state = { triageStarted: false };
        let callIndex = 0;
        const isTriageCall = (): boolean => {
            callIndex += 1;
            return callIndex === 1;
        };
        const provider: LLMProvider = {
            id: 'default',
            name: 'gated',
            defaultModel: 'gated-model',
            models: [],
            async ask() {
                const triage = isTriageCall();
                if (triage) {
                    state.triageStarted = true;
                    await triageGate;
                }
                return {
                    model: 'gated-model',
                    content: [{ type: 'text', text: triage ? negotiateReply : '完成。' }],
                    finishReason: 'stop',
                };
            },
            async *askStream(): AsyncIterable<StreamCompletionEvent> {
                const triage = isTriageCall();
                if (triage) {
                    state.triageStarted = true;
                    await triageGate;
                }
                yield { type: 'text_delta', text: triage ? negotiateReply : '完成。' };
                yield { type: 'finish', finishReason: 'stop' };
            },
        };
        const dir = mkdtempSync(join(tmpdir(), 'mazi-triage-latency-'));
        dirs.push(dir);
        const runtime = new HarnessRuntime(configIn(dir), {
            llmProviders: { default: provider },
        });
        try {
            // triage 的模型调用还没返回，创建已经返回 —— 这正是"用户输入立刻可见"的前提
            const created = await runtime.createGoalSession('帮我批量重命名这 100 个文件', {
                parseIntent: true,
            });
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(state.triageStarted).toBe(true);
            const pending = await runtime.goalSnapshot(created.rootGoalId);
            expect(pending.goals[0]?.negotiation).toBeUndefined();
            expect(pending.goals[0]?.contract?.successConditions).toHaveLength(2);

            releaseTriage?.();
            await waitForTriage(runtime, created.rootGoalId);
            const settled = await runtime.goalSnapshot(created.rootGoalId);
            expect(settled.goals[0]?.negotiation?.route).toBe('negotiate');
        } finally {
            releaseTriage?.();
            await runtime.close();
        }
    });

    it('未开启 triage → fallback 默认执行，创建期不调用模型', async () => {
        const { runtime, calls } = makeRuntime(['完成。']);
        try {
            const created = await runtime.createGoalSession('读取 README 并汇报');
            expect(calls).toHaveLength(0);
            const snap = await runtime.goalSnapshot(created.rootGoalId);
            // 未开启 triage：不记录协商、不调用模型，路径与改造前一致
            expect(snap.goals[0]?.negotiation).toBeUndefined();
            expect(snap.goals[0]?.contract?.successConditions).toHaveLength(2);
            expect(snap.goals[0]?.status).toBe('active');
        } finally {
            await runtime.close();
        }
    });

    it('direct：直答落库并可读（异步 triage 不拦截执行）', async () => {
        const directReply = JSON.stringify({
            blocks: [{ route: 'direct', goals: ['答'], answer: '巴黎。' }],
        });
        const { runtime } = makeRuntime([directReply, '完成。']);
        try {
            const created = await runtime.createGoalSession('法国的首都是哪里？', {
                parseIntent: true,
            });
            await waitForTriage(runtime, created.rootGoalId);
            const snap = await runtime.goalSnapshot(created.rootGoalId);
            expect(snap.goals[0]?.negotiation?.route).toBe('direct');
            expect(snap.goals[0]?.negotiation?.directAnswer).toBe('巴黎。');
            // triage 在创建返回后才落地，因此不会再"替用户决定不执行"
            const result = await runtime.executeGoalTree(created.rootGoalId);
            expect(result.tasks).toHaveLength(1);
        } finally {
            await runtime.close();
        }
    });

    it('escalate：升级诉求落库并可见（异步 triage 不阻塞执行）', async () => {
        const escalateReply = JSON.stringify({
            blocks: [
                {
                    route: 'escalate',
                    goals: ['删库并保留全部数据'],
                    conflicts: ['互斥'],
                    escalation: '请求上游授权',
                },
            ],
        });
        const { runtime } = makeRuntime([escalateReply, '完成。']);
        try {
            const created = await runtime.createGoalSession('删掉生产库但保留全部数据', {
                parseIntent: true,
            });
            await waitForTriage(runtime, created.rootGoalId);
            const snap = await runtime.goalSnapshot(created.rootGoalId);
            expect(snap.goals[0]?.negotiation?.route).toBe('escalate');
            expect(snap.goals[0]?.negotiation?.escalation).toBe('请求上游授权');
            // 不再阻塞：run 照常执行，升级诉求在主会话/ Trace 中显著展示
            const result = await runtime.executeGoalTree(created.rootGoalId);
            expect(result.tasks).toHaveLength(1);
            // 人工答复仍然修订契约
            const revised = await runtime.negotiateGoal(created.rootGoalId, [
                { q: '请求上游授权', answer: '已获授权，改为删除测试库' },
            ]);
            expect(revised.resolved).toBe(true);
        } finally {
            await runtime.close();
        }
    });
});
