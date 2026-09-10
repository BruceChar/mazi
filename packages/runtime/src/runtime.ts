import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type {
    EventBus,
    Goal,
    LLMProvider,
    LLMRequest,
    RuntimeContextBreakdown,
    Step,
    Task,
    ToolSchema,
} from '@mazi/core';
import { ulid } from '@mazi/core';
import { DEEPSEEK_ADAPTER_ID, deepseekAdapter } from '@mazi/provider';
import type { PricingSchedule, RoundOutcome } from './provider/index.js';
import { RoundExecutor } from './provider/index.js';
import type { GoalTreeSnapshot } from '@mazi/libs';
import type { CliCommandSpec, RuntimeConfig, ToolConfig } from './config.js';
import type { GoalToolInvoker } from './gts/goal-executor.js';
import type { ExecutorRoundContext, RoundResult } from './gts/round-types.js';
import { type GoalStore, SqliteGoalStore } from './memory/goal-store.js';
import { ConsoleSink, DefaultEventBus, newHarnessEvent } from './observability/index.js';
import { type GoalRunResult, runGoalTree } from './strategy/goal-strategy.js';
import { BUILTIN_TOOL_PRESET } from './tool-gateway/builtin.js';

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

/** 探测可用包管理器（macOS brew；Linux 依序 apt-get/dnf/apk） */
async function detectPackageManager(): Promise<string | undefined> {
    if (process.platform === 'darwin') {
        return 'brew';
    }
    for (const candidate of ['apt-get', 'dnf', 'apk']) {
        try {
            await promisify(execFile)('which', [candidate], { timeout: 5_000 });
            return candidate;
        } catch {
            // try next
        }
    }
    return undefined;
}

/** 自动安装缺失命令（brew/apt/dnf/apk），返回是否成功 */
async function installCliTool(spec: CliCommandSpec): Promise<{ ok: boolean; error?: string }> {
    const manager = spec.installManager ?? (await detectPackageManager());
    if (!manager) {
        return { ok: false, error: 'no package manager found (brew/apt-get/dnf/apk)' };
    }
    const pkg = spec.installPackage ?? spec.bin;
    const args =
        manager === 'brew'
            ? ['install', '-q', pkg]
            : manager === 'apt-get'
              ? ['install', '-y', pkg]
              : manager === 'dnf'
                ? ['install', '-y', pkg]
                : ['add', pkg];
    try {
        await promisify(execFile)(manager, args, { timeout: 300_000 });
        return { ok: true };
    } catch (error) {
        const err = error as { stderr?: string; message?: string };
        return {
            ok: false,
            error: `${manager} install ${pkg} failed: ${String(err.stderr ?? err.message ?? error)
                .trim()
                .slice(0, 300)}`,
        };
    }
}

/** CLI 工具执行：workspace 内以 argv 运行（不经 shell），输出截断防爆 */

async function runCliTool(
    spec: CliCommandSpec,
    args: Record<string, unknown>,
    workspaceRoot?: string,
): Promise<{ ok: boolean; content?: string; error?: string }> {
    const rootAbs = resolve(workspaceRoot ?? process.cwd());
    const argv: string[] = [];
    for (const token of spec.args) {
        const required = token.match(/^\{(\w+)\}$/);
        const optional = token.match(/^\{(\w+)\?\}$/);
        if (required !== null || optional !== null) {
            const key = (required ?? optional)?.[1] ?? '';
            const value = args[key];
            if (value === undefined || value === null || value === '') {
                if (required !== null) {
                    return { ok: false, error: `缺少参数：${key}` };
                }
                continue;
            }
            if (key === 'path') {
                // 路径必须落在工作区内（防越界读写）
                const target = resolve(rootAbs, String(value));
                const inside = target === rootAbs || target.startsWith(rootAbs + sep);
                if (!inside) {
                    return { ok: false, error: `path escapes the workspace: ${String(value)}` };
                }
            }
            // 数组值展开为多个 argv（如 git status --short）
            if (Array.isArray(value)) {
                for (const item of value) {
                    const part = String(item ?? '');
                    if (part.length > 0) {
                        argv.push(part);
                    }
                }
            } else {
                argv.push(String(value));
            }
            continue;
        }
        argv.push(token);
    }
    const maxChars = spec.maxOutputChars ?? 40_000;
    try {
        const { stdout } = await promisify(execFile)(spec.bin, argv, {
            cwd: rootAbs,
            timeout: spec.timeoutMs ?? 30_000,
            maxBuffer: 1_048_576,
            encoding: 'utf8',
        });
        const text = String(stdout ?? '').trim();
        if (text.length > maxChars) {
            return { ok: true, content: `${text.slice(0, maxChars)}\n…（输出已截断）` };
        }
        return { ok: true, content: text };
    } catch (error) {
        const err = error as { code?: string; stderr?: string; message?: string };
        if (err.code === 'ENOENT') {
            // 自动安装缺失命令后重试一次
            const installed = await installCliTool(spec);
            if (!installed.ok) {
                return {
                    ok: false,
                    error: `${spec.bin} is missing and auto-install failed: ${installed.error}`,
                };
            }
            try {
                const { stdout } = await promisify(execFile)(spec.bin, argv, {
                    cwd: rootAbs,
                    timeout: spec.timeoutMs ?? 30_000,
                    maxBuffer: 1_048_576,
                    encoding: 'utf8',
                });
                const text = String(stdout ?? '').trim();
                return {
                    ok: true,
                    content:
                        text.length > maxChars
                            ? `${text.slice(0, maxChars)}\n…（output truncated）`
                            : text,
                };
            } catch (retryError) {
                const retryErr = retryError as { code?: string; stderr?: string; message?: string };
                if (retryErr.code === 'ENOENT') {
                    return {
                        ok: false,
                        error: `${spec.bin} still missing after install (${spec.installPackage ?? spec.bin})`,
                    };
                }
                const stderr = String(retryErr.stderr ?? '').trim();
                return { ok: false, error: stderr || String(retryErr.message ?? retryError) };
            }
        }
        const stderr = String(err.stderr ?? '').trim();
        return { ok: false, error: stderr || String(err.message ?? error) };
    }
}

/** 粗估文本 token（chars/4，与 provider-runtime estimateInputTokens 同口径） */
function estTokens(text: string): number {
    return Math.max(0, Math.ceil(text.length / 4));
}

/** 上下文分段计量（C3e runtime 维度）：system/history/tool/input/observation → RuntimeContextBreakdown */
function measureContext(
    ctx: {
        messages: LLMRequest['messages'];
        systemPrompt?: string;
        tools: ToolSchema[];
    },
    prevTotal: number | undefined,
    contextWindow: number,
): RuntimeContextBreakdown {
    const textOf = (content: readonly { type: string; text?: string }[]): string =>
        content.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('');
    const messages = ctx.messages;
    let newInputTokens = 0;
    let observationTokens = 0;
    let historyTokens = 0;
    for (let i = 0; i < messages.length; i += 1) {
        const message = messages[i];
        if (message === undefined) continue;
        if (message.role === 'user') {
            if (i === messages.length - 1) {
                newInputTokens = estTokens(textOf(message.content));
            } else {
                historyTokens += estTokens(textOf(message.content));
            }
        } else if (message.role === 'tool') {
            for (const result of message.results) {
                observationTokens += estTokens(
                    typeof result.output === 'string'
                        ? result.output
                        : JSON.stringify(result.output),
                );
            }
        } else if (message.role === 'assistant') {
            historyTokens += estTokens(textOf(message.content));
            for (const call of message.toolCalls ?? []) {
                historyTokens += estTokens(JSON.stringify(call));
            }
        }
    }
    const systemPromptTokens = estTokens(ctx.systemPrompt ?? '');
    const toolSchemaTokens = estTokens(JSON.stringify(ctx.tools ?? []));
    const totalContextTokens =
        systemPromptTokens + historyTokens + toolSchemaTokens + newInputTokens + observationTokens;
    const contextWindowUtilization =
        contextWindow > 0 ? Math.min(1, totalContextTokens / contextWindow) : 0;
    return {
        systemPromptTokens,
        systemPromptRatio: totalContextTokens > 0 ? systemPromptTokens / totalContextTokens : 0,
        historyTokens,
        toolSchemaTokens,
        newInputTokens,
        observationTokens,
        retrievedTokens: 0,
        exampleTokens: 0,
        totalContextTokens,
        contextWindowUtilization,
        contextDeltaFromPrev: prevTotal === undefined ? 0 : totalContextTokens - prevTotal,
        strategyApplied: [],
    };
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

/** Step payload → 完整文本（大上限 60k；长内容由 UI 滚动窗口承载） */
function stepText(step: Step): string {
    const payload = step.payload;
    let text: string;
    if (step.kind === 'thinking') {
        text = String((payload as { content?: string }).content ?? '');
    } else if (step.kind === 'tool_call') {
        const call = payload as { toolName?: string; arguments?: unknown; callId?: string };
        text = `${call.toolName ?? ''} ${JSON.stringify(call.arguments ?? {})}`;
    } else {
        const obs = payload as { toolName?: string; content?: string; isError?: boolean };
        text = `${obs.toolName ? `[${obs.toolName}] ` : ''}${obs.content ?? ''}${
            obs.isError ? '\n[error]' : ''
        }`;
    }
    return text.length > 60_000
        ? `${text.slice(0, 60_000)}\n…（content truncated at 60k chars）`
        : text;
}

const DEFAULT_AGENT_SYSTEM_PROMPT =
    'You are a helpful agent. Answer conversational questions directly. Only call tools when the user explicitly asks you to read, inspect, modify files, or work with the current workspace.';

/** GoalRunResult → goal.ended summary（截断 2000 字符） */
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
 * 事件全部经 DefaultEventBus 落盘 JSONL（按 rootGoalId 分文件）。
 */
export class HarnessRuntime {
    private readonly bus: DefaultEventBus;
    private readonly goalStoreDb: GoalStore;
    /** 上一轮上下文总量（估算跨轮 delta 用） */
    private lastContextTotal?: number;
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

    /** 创建 Goal 会话（intake 根 + 单 work；单意图快速路径，裁决 D4 快速路径）并持久化；发 goal.started */
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
                successConditions: [{ id: ulid(), checkType: 'deterministic' }],
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
                successConditions: [{ id: ulid(), checkType: 'deterministic' }],
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
                type: 'goal.started',
                rootGoalId,
                goalId,
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

    /** 执行 Goal 树（plan → 逐 Task；事实全部经 goalStore 留痕）；发 goal.ended */
    async executeGoalTree(rootGoalId: string): Promise<GoalRunResult> {
        const goals = await this.goalStoreDb.listGoalsByRoot(rootGoalId);
        if (goals.length === 0) {
            throw new Error(`Goal 树不存在：${rootGoalId}`);
        }
        const exec = this.goalExecutionConfig();
        const result = await runGoalTree(
            {
                store: this.goalStoreDb,
                requestRound: (ctx) => this.requestRound(rootGoalId, ctx),
                systemPrompt: this.config.systemPrompt ?? DEFAULT_AGENT_SYSTEM_PROMPT,
                tools: exec.tools,
                invoker: exec.invoker,
                allowedTools: exec.allowedTools,
                onStep: (step) => this.emitStep(rootGoalId, step),
            },
            goals,
        );
        this.bus.emit(
            newHarnessEvent({
                type: 'goal.ended',
                rootGoalId,
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
        snapshot: GoalTreeSnapshot;
    }> {
        const created = await this.createGoalSession(input, opts);
        const result = await this.executeGoalTree(created.rootGoalId);
        const snapshot = await this.goalSnapshot(created.rootGoalId);
        return { rootGoalId: created.rootGoalId, result, snapshot };
    }

    /** 重建 Goal 树四元组快照（审计/展示视图） */
    async goalSnapshot(rootGoalId: string): Promise<GoalTreeSnapshot> {
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

    /** Step 落库即时事件：经事件总线实时推送（SSE/UI 流式展示） */
    private emitStep(rootGoalId: string, step: Step): void {
        const usage = step.usage as
            | { vendor?: Record<string, number>; runtime?: Record<string, number> }
            | undefined;
        const payload: Record<string, unknown> = {
            kind: step.kind,
            status: step.status,
            goalId: step.goalId,
            taskId: step.taskId,
            content: stepText(step),
        };
        if (usage?.vendor || usage?.runtime) {
            payload.usage = {
                vendor: {
                    inputTokens: usage.vendor?.inputTokens ?? 0,
                    outputTokens: usage.vendor?.outputTokens ?? 0,
                    ...(usage.vendor?.cacheReadInputTokens !== undefined
                        ? { cacheReadInputTokens: usage.vendor.cacheReadInputTokens }
                        : {}),
                    ...(usage.vendor?.reasoningOutputTokens !== undefined
                        ? { reasoningOutputTokens: usage.vendor.reasoningOutputTokens }
                        : {}),
                },
                runtime: {
                    totalContextTokens: usage.runtime?.totalContextTokens ?? 0,
                    systemPromptTokens: usage.runtime?.systemPromptTokens ?? 0,
                    historyTokens: usage.runtime?.historyTokens ?? 0,
                    toolSchemaTokens: usage.runtime?.toolSchemaTokens ?? 0,
                    newInputTokens: usage.runtime?.newInputTokens ?? 0,
                    observationTokens: usage.runtime?.observationTokens ?? 0,
                    ...(usage.runtime?.estimationDriftTokens !== undefined
                        ? { estimationDriftTokens: usage.runtime.estimationDriftTokens }
                        : {}),
                },
            };
        }
        this.bus.emit(
            newHarnessEvent({
                type: 'step.ended',
                rootGoalId,
                goalId: step.goalId,
                taskId: step.taskId,
                stepId: step.stepId,
                payload,
            }),
        );
    }

    /** 用户对 root goal 结果的反馈（CLI/调用方显式给出） */
    recordFeedback(rootGoalId: string, feedback: FeedbackInput): Promise<void> {
        this.bus.emit(
            newHarnessEvent({
                type: 'user.feedback.captured',
                rootGoalId,
                attributes: { 'user.feedback_type': feedback.type },
                payload: { feedback },
            }),
        );
        return this.bus.flush();
    }

    /** Goal 执行的工具面：内置 CLI 预设 + config.tools → ToolSchema/执行器/白名单。
     *  白名单缺省 = 放行全部工具；显式空数组 = 纯对话（不注入工具 schema）。 */
    private goalExecutionConfig(): {
        tools: ToolSchema[];
        invoker: GoalToolInvoker;
        allowedTools: string[];
    } {
        // 预设与配置同名合并：配置覆盖预设；其余内置 CLI 工具自动可用
        const merged: ToolConfig[] = [...BUILTIN_TOOL_PRESET];
        for (const tool of this.config.tools) {
            const idx = merged.findIndex((t) => t.name === tool.name);
            if (idx >= 0) {
                merged[idx] = tool;
            } else {
                merged.push(tool);
            }
        }
        const allowed = this.config.goal?.allowedTools;
        const tools: ToolSchema[] = merged.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: (t.parameters ?? undefined) as ToolSchema['parameters'],
        }));
        const names = allowed === undefined ? tools.map((t) => t.name) : allowed;
        const selected = tools.filter((t) => names.includes(t.name));
        const invoke: GoalToolInvoker['invoke'] = async (toolName, args) => {
            const tool = merged.find((t) => t.name === toolName);
            if (toolName === 'fs.read') {
                const res = await fsReadToolImpl(args, this.workspaceRoot);
                return res.ok
                    ? { ok: true, content: String(res.content ?? '') }
                    : { ok: false, content: '', error: res.error ?? 'tool failed' };
            }
            if (tool?.command) {
                const res = await runCliTool(tool.command, args, this.workspaceRoot);
                return res.ok
                    ? { ok: true, content: res.content ?? '' }
                    : { ok: false, content: '', error: res.error ?? 'tool failed' };
            }
            const impl = tool?.impl;
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

    /** 解析候选 provider 的模型 id：命中 ctx 目标且非占位值时用 ctx 模型，否则取配置/默认模型 */
    private roundModelId(
        id: string,
        ctxModel: { providerId: string; modelId: string },
        provider: LLMProvider,
    ): string | undefined {
        if (id === ctxModel.providerId && ctxModel.modelId && ctxModel.modelId !== 'default') {
            return ctxModel.modelId;
        }
        return this.defaultModelOf(id) || provider.defaultModel || undefined;
    }

    /**
     * 单次 LLM 轮次：经 provider-runtime RoundExecutor（重试/failover 在 provider-runtime 内）。
     * 具备 goalId/taskId 时，把 provider 原始流式增量包装成 llm.stream_event 实时发到事件总线
     * （docs/web/流式响应设计.md §2）；同一轮的多次网络尝试共享 streamId，attempt 区分重试。
     */
    private async requestRound(
        rootGoalId: string,
        ctx: ExecutorRoundContext,
    ): Promise<RoundResult> {
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
                modelId: this.roundModelId(id, ctx.model, provider),
                pricing: this.pricingOf(id),
            }));
        if (candidates.length === 0) {
            throw new Error(`没有可用 provider：${ctx.model.providerId}`);
        }
        // 不设 request.model：模型 id 交由 provider-runtime 按候选（candidate.modelId）解析，
        // 避免占位 modelId（goal-executor 缺省 'default'）覆盖真实模型而报 unknown model。
        const request: LLMRequest = {
            ...(ctx.systemPrompt ? { system: ctx.systemPrompt } : {}),
            messages: ctx.messages,
            ...(ctx.tools.length > 0 ? { tools: ctx.tools } : {}),
        };
        // runtime 维度：请求发出前的上下文分段计量（跨轮累计 delta）
        const contextUsage = measureContext(
            ctx,
            this.lastContextTotal,
            this.config.contextWindow ?? 64000,
        );
        const streamId = ulid();
        const streamable = ctx.goalId !== undefined && ctx.taskId !== undefined;
        const outcome = await this.roundExecutor.execute(
            request,
            candidates,
            streamable
                ? (streamEvent) => {
                      this.bus.emit(
                          newHarnessEvent({
                              type: 'llm.stream_event',
                              rootGoalId,
                              goalId: ctx.goalId,
                              taskId: ctx.taskId,
                              attributes: {
                                  'gen_ai.provider.name': streamEvent.providerId,
                                  'gen_ai.request.model': streamEvent.modelId,
                              },
                              payload: {
                                  streamId,
                                  attempt: streamEvent.attempt,
                                  event: streamEvent.event,
                              },
                          }),
                      );
                  }
                : undefined,
        );
        const result: RoundResult = toRoundResult(outcome);
        this.lastContextTotal = contextUsage.totalContextTokens;
        // 估算漂移：|runtime total − vendor.inputTokens|（vendor 已上报时回填）
        const vendorInput = result.vendorUsage?.inputTokens;
        if (vendorInput !== undefined) {
            contextUsage.estimationDriftTokens = Math.abs(
                contextUsage.totalContextTokens - vendorInput,
            );
        }
        return { ...result, contextUsage };
    }
}
