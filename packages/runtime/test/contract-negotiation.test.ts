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
import { parseGoalParserOutput, planNegotiation } from '../src/gts/negotiation.js';
import { HarnessRuntime } from '../src/harness/index.js';
import { snapshotGoalTree } from '../src/observability/goal-snapshot.js';

/** 脚本化 provider：按调用顺序返回预置文本（第 1 次 = triage，之后 = 执行轮）。 */
function scriptedProvider(replies: string[]): {
    provider: LLMProvider;
    calls: string[];
    requests: LLMRequest[];
} {
    const calls: string[] = [];
    const requests: LLMRequest[] = [];
    const pick = (): string => replies[Math.min(calls.length - 1, replies.length - 1)] ?? '';
    const record = (request: LLMRequest): void => {
        requests.push(request);
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
    return { provider, calls, requests };
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

function makeRuntime(
    replies: string[],
    workspace?: string,
): { runtime: HarnessRuntime; calls: string[]; requests: LLMRequest[] } {
    const dir = mkdtempSync(join(tmpdir(), 'mazi-negotiate-'));
    dirs.push(dir);
    const scripted = scriptedProvider(replies);
    const runtime = new HarnessRuntime(configIn(dir), {
        llmProviders: { default: scripted.provider },
        ...(workspace !== undefined ? { workspaceRoot: workspace } : {}),
    });
    return { runtime, calls: scripted.calls, requests: scripted.requests };
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
    it('triage 收到统一 Session Context 与会话历史，无需用户重复当前项目', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'agentwin-session-'));
        dirs.push(workspace);
        const { runtime, requests } = makeRuntime([negotiateReply], workspace);
        try {
            const created = await runtime.createGoalSession('这个项目接下来怎么推进？', {
                parseIntent: true,
                history: [
                    { role: 'user', text: '我们在分析 agentwin 的行情与策略模块' },
                    { role: 'assistant', text: '已确认当前讨论的是 agentwin。' },
                ],
            });
            await waitForTriage(runtime, created.rootGoalId);
            const triage = requests[0];
            const system = typeof triage?.system === 'string' ? triage.system : '';
            expect(system).toContain('## Session Context');
            expect(system).toContain(`Workspace: ${workspace}`);
            expect(system).toContain(`Project: ${workspace.split('/').at(-1)}`);
            expect(system).toContain('Do not ask the user to repeat information');
            expect(
                triage?.messages.some(
                    (message) =>
                        message.content.some(
                            (block) =>
                                block.type === 'text' &&
                                block.text.includes('当前讨论的是 agentwin'),
                        ),
                ),
            ).toBe(true);
        } finally {
            await runtime.close();
        }
    });

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

    it('direct：已有直答时零 Task/Step 结束，不再调用执行模型', async () => {
        const directReply = JSON.stringify({
            blocks: [{ route: 'direct', goals: ['答'], answer: '巴黎。' }],
        });
        const { runtime, calls } = makeRuntime([directReply, '完成。']);
        try {
            const created = await runtime.createGoalSession('法国的首都是哪里？', {
                parseIntent: true,
            });
            await waitForTriage(runtime, created.rootGoalId);
            const snap = await runtime.goalSnapshot(created.rootGoalId);
            expect(snap.goals[0]?.negotiation?.route).toBe('direct');
            expect(snap.goals[0]?.negotiation?.directAnswer).toBe('巴黎。');
            const result = await runtime.executeGoalTree(created.rootGoalId);
            expect(result).toMatchObject({ ok: true, tasks: [], finalAnswer: '巴黎。' });
            // 只有 triage 这一次模型调用；direct 不进入 planner 或 executor。
            expect(calls).toHaveLength(1);
            const settled = await runtime.goalSnapshot(created.rootGoalId);
            expect(settled.goals[0]?.status).toBe('succeeded');
            expect(settled.taskCount).toBe(0);
            expect(settled.stepCount).toBe(0);
            const ended = runtime.eventBus
                .replay(created.rootGoalId)
                .find((event) => event.type === 'goal.ended');
            expect(ended?.payload).toMatchObject({
                outcome: { status: 'success', summary: '巴黎。' },
            });
        } finally {
            await runtime.close();
        }
    });

    it('direct 缺回答时回落正常执行，不伪造终态', async () => {
        const directWithoutAnswer = JSON.stringify({
            blocks: [{ route: 'direct', goals: ['答'] }],
        });
        const { runtime, calls } = makeRuntime([directWithoutAnswer, '完成。']);
        try {
            const created = await runtime.createGoalSession('法国首都？', { parseIntent: true });
            await waitForTriage(runtime, created.rootGoalId);
            const result = await runtime.executeGoalTree(created.rootGoalId);
            expect(result.ok).toBe(true);
            expect(result.tasks).toHaveLength(1);
            expect(calls).toHaveLength(2);
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

/** confirmed block 的稳定外壳；constraints 允许 string 或结构化对象。 */
function confirmedRaw(constraints: unknown[]): string {
    return JSON.stringify({
        trace: { classification: 'command', triggers: [] },
        blocks: [{ route: 'confirmed', goals: ['写 README'], constraints }],
    });
}

describe('结构化 constraint → 机械条款（P2）', () => {
    it('解析 { text, check }：四种合法 check 保留；旧字符串原样保留', () => {
        const parsed = parseGoalParserOutput(
            confirmedRaw([
                '旧字符串约束',
                {
                    text: 'README.md 必须存在',
                    check: { kind: 'file-exists', path: 'README.md' },
                },
                {
                    text: 'README 必须含安装说明',
                    check: { kind: 'file-contains', path: 'README.md', text: '## Install' },
                },
                { text: '仓库必须已有 commit', check: { kind: 'git-has-commit' } },
                {
                    text: '测试输出必须含 5 passed',
                    check: {
                        kind: 'command-output-contains',
                        commandPattern: 'pnpm test',
                        text: '5 passed',
                    },
                },
            ]),
        );
        expect(parsed?.blocks[0]?.constraints).toEqual([
            '旧字符串约束',
            { text: 'README.md 必须存在', check: { kind: 'file-exists', path: 'README.md' } },
            {
                text: 'README 必须含安装说明',
                check: { kind: 'file-contains', path: 'README.md', text: '## Install' },
            },
            { text: '仓库必须已有 commit', check: { kind: 'git-has-commit' } },
            {
                text: '测试输出必须含 5 passed',
                check: {
                    kind: 'command-output-contains',
                    commandPattern: 'pnpm test',
                    text: '5 passed',
                },
            },
        ]);
    });

    it('非法 check 降级：未知 kind / 缺字段 / 类型不符 / 非相对路径 → 丢 check 留 text，block 照常解析', () => {
        const parsed = parseGoalParserOutput(
            confirmedRaw([
                { text: '缺 path', check: { kind: 'file-exists' } },
                { text: '未知 kind', check: { kind: 'run-tests' } },
                { text: '绝对路径', check: { kind: 'file-exists', path: '/etc/passwd' } },
                { text: '逃逸路径', check: { kind: 'file-exists', path: '../outside' } },
                { text: '字段类型不符', check: { kind: 'file-contains', path: 'a', text: 42 } },
                { text: 42, check: { kind: 'git-has-commit' } },
                { check: { kind: 'git-has-commit' } },
                { text: '合法 check', check: { kind: 'git-has-commit' } },
                '纯字符串',
            ]),
        );
        // 单条 constraint 形状坏掉不能拖垮整个 block
        expect(parsed).toBeDefined();
        expect(parsed?.blocks[0]?.route).toBe('confirmed');
        expect(parsed?.blocks[0]?.constraints).toEqual([
            { text: '缺 path' },
            { text: '未知 kind' },
            { text: '绝对路径' },
            { text: '逃逸路径' },
            { text: '字段类型不符' },
            { text: '合法 check', check: { kind: 'git-has-commit' } },
            '纯字符串',
        ]);
    });

    it('planNegotiation：合法 check → deterministic + check；goals / 旧字符串 / 降级条款仍 semantic', () => {
        const parsed = parseGoalParserOutput(
            confirmedRaw([
                '语义约束',
                {
                    text: 'README.md 必须存在',
                    check: { kind: 'file-exists', path: 'README.md' },
                },
                { text: '降级约束', check: { kind: 'file-exists' } },
            ]),
        );
        const { conditions } = planNegotiation(parsed);
        // 基线 2 + goals 1 + constraints 3
        expect(conditions).toHaveLength(6);
        const byDescription = (text: string) =>
            conditions.find((item) => item.description === text);

        expect(byDescription('README.md 必须存在')).toMatchObject({
            checkType: 'deterministic',
            check: { kind: 'file-exists', path: 'README.md' },
        });
        expect(byDescription('语义约束')).toMatchObject({ checkType: 'semantic' });
        expect(byDescription('语义约束')?.check).toBeUndefined();
        expect(byDescription('降级约束')).toMatchObject({ checkType: 'semantic' });
        expect(byDescription('降级约束')?.check).toBeUndefined();
        // goals 永远是语义条款（目标本身不是可机械判定的形状）
        expect(byDescription('写 README')).toMatchObject({ checkType: 'semantic' });
        // 每个条款独立 id
        expect(new Set(conditions.map((item) => item.id)).size).toBe(conditions.length);
    });

    it('negotiate：defaultPath 仍为语义条款', () => {
        const parsed = parseGoalParserOutput(
            JSON.stringify({
                blocks: [
                    {
                        route: 'negotiate',
                        defaultPath: ['先只写 README'],
                        questions: [{ q: '范围？', default: '仅 README' }],
                    },
                ],
            }),
        );
        const { conditions } = planNegotiation(parsed);
        expect(conditions).toHaveLength(3);
        expect(conditions[2]).toMatchObject({
            checkType: 'semantic',
            description: '先只写 README',
        });
        expect(conditions[2]?.check).toBeUndefined();
    });

    it('旧字符串 constraints 兼容：原样解析为 string，全部落成语义条款', () => {
        const parsed = parseGoalParserOutput(confirmedRaw(['约束一', '约束二']));
        expect(parsed?.blocks[0]?.constraints).toEqual(['约束一', '约束二']);
        const { conditions } = planNegotiation(parsed);
        expect(conditions.filter((item) => item.checkType === 'semantic')).toHaveLength(3);
        expect(conditions.filter((item) => item.checkType === 'deterministic')).toHaveLength(2);
    });

    it('triage 结构化 constraint → planNegotiation → wire 投影：check 不丢失（库层端到端）', () => {
        const parsed = parseGoalParserOutput(
            confirmedRaw([
                {
                    text: 'README.md 必须存在',
                    check: { kind: 'file-exists', path: 'README.md' },
                },
            ]),
        );
        const { conditions } = planNegotiation(parsed);
        const goal = {
            goalId: 'g1',
            statement: '给项目写 README',
            contract: {
                successConditions: conditions,
                failureConditions: [],
                forbiddenResources: [],
                budget: {},
                terminationPolicy: {},
                riskProfile: {
                    hasIrreversibleActions: false,
                    touchesNetwork: false,
                    touchesExternalApi: false,
                },
            },
            permissionCeiling: 'read-only' as const,
            budget: {},
            status: 'active' as const,
            createdAt: 1,
        };
        const snapshot = snapshotGoalTree('g1', [goal], [], []);
        const view = snapshot.goals[0]?.contract;
        const viaCheck = view?.successConditions.find(
            (item) => item.description === 'README.md 必须存在',
        );
        expect(viaCheck?.checkType).toBe('deterministic');
        expect(viaCheck?.check).toEqual({ kind: 'file-exists', path: 'README.md' });
        // 基线 2 条 + file-exists 1 条 = 3 / 总 4（goals 1 条 + constraints 1 条）
        expect(view?.deterministicRatio).toBeCloseTo(3 / 4, 6);
    });
});
