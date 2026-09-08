import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { EventBus, Goal, LLMProvider, LLMRequest, Step, Task, ToolSchema } from '@mazi/core';
import { ulid } from '@mazi/core';
import { DEEPSEEK_ADAPTER_ID, deepseekAdapter } from '@mazi/provider';
import type { PricingSchedule, RoundOutcome } from '@mazi/provider-runtime';
import { RoundExecutor } from '@mazi/provider-runtime';
import type { RuntimeConfig } from './config.js';
import type { GoalToolInvoker } from './executor/goal-executor.js';
import { type GoalStore, SqliteGoalStore } from './memory/goal-store.js';
import { ConsoleSink, DefaultEventBus, newHarnessEvent } from './observability/index.js';
import { type GoalRunResult, runGoalTree } from './strategy/goal-strategy.js';

/** 用户反馈载荷（core 旧 UserInteractionRecord 已删；事件契约只取展示字段） */
export interface FeedbackInput {
    type: string;
    content?: string;
    rating?: number;
    timestamp: number;
}

export interface RunOptions {
    userId?: string;
    /** 工作区根路径；文件工具只允许读取该目录内文件 */
    workspaceRoot?: string;
    /** providerId → LLMProvider 覆盖（离线测试注入；优先生效） */
    llmProviders?: Record<string, LLMProvider>;
}

function fsReadToolImpl(
    args: Record<string, unknown>,
    workspaceRoot?: string,
): Promise<{ ok: boolean; content?: unknown; error?: string; retryable?: boolean }> {
    const path = typeof args.path === 'string' ? args.path : undefined;
    if (!path) {
        return Promise.resolve({ ok: false, error: '缺少 path 参数' });
    }
    const absolutePath = resolve(workspaceRoot ?? process.cwd(), path);
    if (workspaceRoot && !absolutePath.startsWith(resolve(workspaceRoot))) {
        return Promise.resolve({
            ok: false,
            error: 'path 超出当前工作区权限范围',
            retryable: false,
        });
    }
    try {
        const content = readFileSync(absolutePath, 'utf8');
        return Promise.resolve({ ok: true, content });
    } catch (error) {
        return Promise.resolve({ ok: false, error: (error as Error).message, retryable: false });
    }
}

/** 装配 LLMProvider 池：override 优先；deepseek 经 pi-ai 目录适配（目录不匹配/无 key 在调用期报错，装配期跳过并告警） */
function buildLlmProviders(config: RuntimeConfig, options: RunOptions): Map<string, LLMProvider> {
    const map = new Map<string, LLMProvider>();
    const overrides = options.llmProviders ?? {};
    // override 独立于 config.providers 注册（测试/宿主注入 provider 不必出现在配置列表）
    for (const [id, provider] of Object.entries(overrides)) {
        map.set(id, provider);
    }
    for (const provider of config.providers) {
        if (map.has(provider.id)) {
            continue;
        }
        if (provider.driver.provider === DEEPSEEK_ADAPTER_ID) {
            try {
                const modelIds = provider.models?.length
                    ? provider.models.map((m) => ({ id: m.id }))
                    : [{ id: provider.driver.model }];
                map.set(
                    provider.id,
                    deepseekAdapter(
                        {
                            id: provider.id,
                            adapter: DEEPSEEK_ADAPTER_ID,
                            apiKeyEnv: provider.driver.apiKeyEnv,
                            models: modelIds,
                        },
                        { env: process.env },
                    ),
                );
            } catch (error) {
                // biome-ignore lint/suspicious/noConsole: 装配期跳过告警（面向用户运行日志）
                console.warn(
                    `[runtime] skip provider '${provider.id}': ${(error as Error).message}`,
                );
            }
        }
    }
    return map;
}

/** provider-runtime RoundOutcome → RoundResult（Step 回注所需最小事实面） */
function toRoundResult(outcome: RoundOutcome): {
    text: string;
    reasoning: string;
    toolCalls: Array<{ callId: string; toolName: string; arguments: Record<string, unknown> }>;
    vendorUsage?: import('@mazi/core').VendorUsage;
    finishReason?: string;
    ttftMs: number;
    totalMs: number;
} {
    let text = '';
    let reasoning = '';
    for (const block of outcome.response.content) {
        if (block.type === 'text') text += block.text;
        else if (block.type === 'reasoning') reasoning += block.text;
    }
    const toolCalls = (outcome.response.toolCalls ?? []).map((toolCall) => ({
        callId: toolCall.callId,
        toolName: toolCall.name,
        arguments: toolCall.arguments,
    }));
    const usage = outcome.response.usage;
    const vendorUsage =
        usage === undefined
            ? undefined
            : {
                  inputTokens: usage.inputTokens ?? 0,
                  outputTokens: usage.outputTokens ?? 0,
                  cacheReadInputTokens: usage.cachedInputTokens,
                  cacheCreationInputTokens: undefined,
                  reasoningOutputTokens: usage.reasoningTokens,
                  reportedByVendor: true,
              };
    return {
        text,
        reasoning,
        toolCalls,
        ...(vendorUsage ? { vendorUsage } : {}),
        finishReason: outcome.response.finishReason,
        ttftMs: outcome.metrics.ttftMs ?? 0,
        totalMs: outcome.metrics.totalMs,
    };
}

const DEFAULT_AGENT_SYSTEM_PROMPT =
    'You are a helpful agent. Answer conversational questions directly. Only call tools when the user explicitly asks you to read, inspect, modify files, or work with the current workspace.';

/** GoalRunResult → session.ended summary（截断 2000 字符） */
function goalRunSummary(result: GoalRunResult): string {
    const last = result.tasks[result.tasks.length - 1];
    if (result.rejected && result.rejected.length > 0) {
        return result.rejected.join('；').slice(0, 2000);
    }
    const summary = last?.finalMessage ?? last?.errorMessage;
    return summary && summary.length > 0 ? summary.slice(0, 2000) : '';
}

/**
 * HarnessRuntime —— Goal/Task/Step 坐标系运行器（C5 收口后为唯一执行面）。
 * createGoalSession（intake+work 树落库）→ executeGoalTree（plan→逐 Task，事实经 GoalStore 留痕）；
 * 事件全部经 DefaultEventBus 落盘 JSONL（sessionId 槽 = rootGoalId，词汇收敛属 C3e/OBS）。
 */
export class HarnessRuntime {
    private readonly bus: DefaultEventBus;
    private readonly goalStoreDb: GoalStore;
    private readonly llmProviders: Map<string, LLMProvider>;
    private readonly roundExecutor: RoundExecutor;
    private readonly config: RuntimeConfig;
    private readonly workspaceRoot?: string;

    constructor(config: RuntimeConfig, options: RunOptions = {}) {
        this.config = config;
        this.workspaceRoot = options.workspaceRoot;
        this.bus = new DefaultEventBus({ eventDir: config.eventDir });
        this.goalStoreDb = new SqliteGoalStore(config.dbPath ?? ':memory:');
        this.llmProviders = buildLlmProviders(config, options);
        this.roundExecutor = new RoundExecutor();
        if (config.consoleEnabled ?? false) {
            this.bus.subscribe({}, new ConsoleSink());
        }
    }

    get eventBus(): EventBus {
        return this.bus;
    }

    /** Goal/Task/Step 存储（Goal 会话审计/级联删除） */
    get goalStore(): GoalStore {
        return this.goalStoreDb;
    }

    get currentWorkspaceRoot(): string | undefined {
        return this.workspaceRoot;
    }

    async close(): Promise<void> {
        this.goalStoreDb.close();
    }

    /** 创建 Goal 会话（intake 根 + 单 work；单意图快速路径，裁决 D4 快速路径）并持久化；发 session.started */
    async createGoalSession(
        input: string,
        opts: RunOptions = {},
    ): Promise<{ rootGoalId: string; goalId: string }> {
        const rootGoalId = ulid();
        const goalId = ulid();
        const ceiling = this.config.goal?.permissionCeiling ?? 'read-only';
        const intake: Goal = {
            goalId: rootGoalId,
            rootGoalId,
            origin: { kind: 'human' },
            kind: 'intake',
            statement: input,
            contract: {
                successConditions: [{ id: 'intake-complete', checkType: 'deterministic' }],
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
            permissionCeiling: ceiling,
            budget: {},
            status: 'active',
            createdAt: Date.now(),
        };
        const work: Goal = {
            goalId,
            rootGoalId,
            parent: { type: 'split', goalId: rootGoalId },
            kind: 'work',
            statement: input,
            contract: {
                successConditions: [{ id: 'input-satisfied', checkType: 'deterministic' }],
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
            permissionCeiling: ceiling,
            budget: {},
            status: 'active',
            createdAt: Date.now(),
        };
        await this.goalStoreDb.saveGoal(intake);
        await this.goalStoreDb.saveGoal(work);
        this.bus.emit(
            newHarnessEvent({
                type: 'session.started',
                sessionId: rootGoalId,
                attributes: {},
                payload: {
                    rawInput: input,
                    inputTimestamp: Date.now(),
                    userId: opts.userId ?? undefined,
                },
            }),
        );
        await this.bus.flush();
        return { rootGoalId, goalId };
    }

    /** 执行 Goal 树（plan → 逐 Task；事实全部经 goalStore 留痕）；发 session.ended */
    async executeGoalTree(rootGoalId: string): Promise<GoalRunResult> {
        const goals = await this.goalStoreDb.listGoalsByRoot(rootGoalId);
        if (goals.length === 0) {
            throw new Error(`Goal 树不存在：${rootGoalId}`);
        }
        const exec = this.goalExecutionConfig();
        const result = await runGoalTree(
            {
                store: this.goalStoreDb,
                requestRound: (ctx) => this.requestRound(ctx),
                systemPrompt: this.config.systemPrompt ?? DEFAULT_AGENT_SYSTEM_PROMPT,
                tools: exec.tools,
                invoker: exec.invoker,
                allowedTools: exec.allowedTools,
            },
            goals,
        );
        this.bus.emit(
            newHarnessEvent({
                type: 'session.ended',
                sessionId: rootGoalId,
                payload: {
                    outcome: {
                        status: result.ok ? 'success' : 'failed',
                        summary: goalRunSummary(result),
                    },
                    error: result.rejected?.join('；'),
                },
            }),
        );
        await this.bus.flush();
        return result;
    }

    /** 一站式 Goal 会话：创建 + 执行 + 返回结果与树快照（apps/api 端点消费） */
    async runGoalSession(
        input: string,
        opts: RunOptions = {},
    ): Promise<{
        rootGoalId: string;
        result: GoalRunResult;
        snapshot: import('./observability/goal-snapshot.js').GoalTreeSnapshot;
    }> {
        const created = await this.createGoalSession(input, opts);
        const result = await this.executeGoalTree(created.rootGoalId);
        const snapshot = await this.goalSnapshot(created.rootGoalId);
        return { rootGoalId: created.rootGoalId, result, snapshot };
    }

    /** 重建 Goal 树四元组快照（审计/展示视图） */
    async goalSnapshot(
        rootGoalId: string,
    ): Promise<import('./observability/goal-snapshot.js').GoalTreeSnapshot> {
        const goals = await this.goalStoreDb.listGoalsByRoot(rootGoalId);
        const tasks: Task[] = [];
        const steps: Step[] = [];
        for (const goal of goals) {
            const goalTasks = await this.goalStoreDb.listTasks(goal.goalId);
            tasks.push(...goalTasks);
            for (const task of goalTasks) {
                steps.push(...(await this.goalStoreDb.listSteps(task.taskId)));
            }
        }
        const { snapshotGoalTree } = await import('./observability/goal-snapshot.js');
        return snapshotGoalTree(rootGoalId, goals, tasks, steps);
    }

    /** 用户对会话结果的反馈（CLI/调用方显式给出；sessionId = rootGoalId） */
    recordFeedback(sessionId: string, feedback: FeedbackInput): Promise<void> {
        this.bus.emit(
            newHarnessEvent({
                type: 'user.feedback.captured',
                sessionId,
                attributes: { 'user.feedback_type': feedback.type },
                payload: { feedback },
            }),
        );
        return this.bus.flush();
    }

    /** Goal 执行的工具面：config.tools → ToolSchema 清单 + GoalToolInvoker + 白名单。
     *  白名单缺省 = 放行全部已配置工具；显式空数组 = 纯对话（不注入任何工具 schema）。 */
    private goalExecutionConfig(): {
        tools: ToolSchema[];
        invoker: GoalToolInvoker;
        allowedTools: string[];
    } {
        const allowed = this.config.goal?.allowedTools;
        const tools: ToolSchema[] = this.config.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: (t.parameters ?? undefined) as ToolSchema['parameters'],
        }));
        const names = allowed === undefined ? tools.map((t) => t.name) : allowed;
        const selected = tools.filter((t) => names.includes(t.name));
        const invoke: GoalToolInvoker['invoke'] = async (toolName, args) => {
            if (toolName === 'fs.read') {
                const res = await fsReadToolImpl(args, this.workspaceRoot);
                return res.ok
                    ? { ok: true, content: String(res.content ?? '') }
                    : { ok: false, content: '', error: res.error ?? 'tool failed' };
            }
            const impl = this.config.tools.find((t) => t.name === toolName)?.impl;
            if (!impl) {
                return { ok: false, content: '', error: `工具未实现：${toolName}` };
            }
            const res = await impl(args);
            return res.ok
                ? { ok: true, content: String(res.content ?? '') }
                : { ok: false, content: '', error: res.error ?? 'tool failed' };
        };
        return { tools: selected, invoker: { invoke }, allowedTools: names };
    }

    private defaultModelOf(providerId: string): string {
        const entry = this.config.providers.find((p) => p.id === providerId);
        return entry?.driver.model || entry?.models?.[0]?.id || '';
    }

    private pricingOf(providerId: string): PricingSchedule | undefined {
        return this.config.providers.find((p) => p.id === providerId)?.pricing;
    }

    /** 单次 LLM 轮次：经 provider-runtime RoundExecutor（重试/failover 在 provider-runtime 内） */
    private async requestRound(ctx: {
        model: { providerId: string; modelId: string };
        messages: LLMRequest['messages'];
        systemPrompt?: string;
        tools: ToolSchema[];
        signal?: AbortSignal;
    }): Promise<Awaited<ReturnType<typeof toRoundResult>>> {
        const orderedIds = [
            ctx.model.providerId,
            ...[...this.llmProviders.keys()].filter((id) => id !== ctx.model.providerId),
        ];
        const candidates = orderedIds
            .map((id) => ({ id, provider: this.llmProviders.get(id) }))
            .filter((x): x is { id: string; provider: LLMProvider } => x.provider !== undefined)
            .map(({ id, provider }) => ({
                providerId: id,
                provider,
                modelId:
                    id === ctx.model.providerId && ctx.model.modelId
                        ? ctx.model.modelId
                        : this.defaultModelOf(id),
                pricing: this.pricingOf(id),
            }));
        if (candidates.length === 0) {
            throw new Error(`没有可用 provider：${ctx.model.providerId}`);
        }
        const request: LLMRequest = {
            ...(ctx.systemPrompt ? { system: ctx.systemPrompt } : {}),
            messages: ctx.messages,
            ...(ctx.tools.length > 0 ? { tools: ctx.tools } : {}),
            model: ctx.model.modelId,
        };
        const outcome = await this.roundExecutor.execute(request, candidates);
        return toRoundResult(outcome);
    }
}
