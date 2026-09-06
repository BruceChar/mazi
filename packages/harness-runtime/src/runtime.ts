import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
    EventBus,
    FeatureFlagDefinition,
    GoalContract,
    LLMDriver,
    MemoryStore,
    Planner,
    PolicyEngine,
    Session,
    StrategyContext,
    ToolExecutionResult,
    ToolInvoker,
    ToolRegistry,
    Turn,
    UserFeedback,
    UserInteractionRecord,
} from '@mazi/core';
import { ulid } from '@mazi/core';
import { Executor } from '@mazi/executor';
import { createFlagSnapshot, DEFAULT_FLAGS } from '@mazi/flags';
import { SqliteMemoryStore } from '@mazi/memory';
import { ConsoleSink, DefaultEventBus, newHarnessEvent } from '@mazi/observability';
import { MvpPlanner } from '@mazi/planner';
import { PolicyEngineImpl } from '@mazi/policy';
import {
    collectLLMRound,
    DefaultDriverRegistry,
    normalizeProvider,
    SimpleRouter,
} from '@mazi/provider-llm';
import { FullLoopStrategy } from '@mazi/strategy-full-loop';
import { ContextMeter, CostCalculator } from '@mazi/usage';
import { getRecordBySession, UserProfileRecorder } from '@mazi/user-profile';
import type { RuntimeConfig } from './config.js';
import { buildGoal } from './goal-factory.js';

export interface RunResult {
    sessionId: string;
    outcome?: Session['outcome'];
    summary?: string;
    totalCostUsd: number;
    totalTokens: number;
    turnCount: number;
    record?: UserInteractionRecord;
}

export interface RunOptions {
    userId?: string;
    /** 工作区根路径；文件工具只允许读取该目录内文件 */
    workspaceRoot?: string;
}

/** createSession 可覆盖的 Goal 项（webui 新建会话配置） */
export type SessionGoalOverrides = NonNullable<RuntimeConfig['goal']>;

export interface CreateSessionOptions extends RunOptions {
    /** GoalContract 生成时覆盖默认配置（permissionCeiling/budget/超时/约束等） */
    goal?: SessionGoalOverrides;
}

function fsReadToolImpl(
    args: Record<string, unknown>,
    workspaceRoot?: string,
): Promise<ToolExecutionResult> {
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

/** 由 ToolConfig 构建 ToolRegistry + ToolInvoker */
function buildTools(
    config: RuntimeConfig,
    workspaceRoot?: string,
): { registry: ToolRegistry; invoker: ToolInvoker } {
    const specs = config.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        minPermission: t.minPermission,
        irreversible: t.irreversible,
        sideEffects: t.sideEffects,
    }));
    const impls = new Map<
        string,
        (args: Record<string, unknown>) => Promise<ToolExecutionResult>
    >();
    for (const t of config.tools) {
        impls.set(
            t.name,
            t.name === 'fs.read'
                ? (args) => fsReadToolImpl(args, workspaceRoot)
                : (t.impl ?? defaultNoImpl(t.name)),
        );
    }
    const registry: ToolRegistry = {
        resolve(requirements) {
            const byName = new Map(specs.map((s) => [s.name, s]));
            const tools: typeof specs = [];
            const missingRequired: string[] = [];
            const missingOptional: string[] = [];
            for (const req of requirements) {
                const spec = byName.get(req.nameOrCapability);
                if (spec) {
                    if (!tools.some((t) => t.name === spec.name)) {
                        tools.push(spec);
                    }
                } else if (req.required) {
                    missingRequired.push(req.nameOrCapability);
                } else {
                    missingOptional.push(req.nameOrCapability);
                }
            }
            return { tools, missingRequired, missingOptional };
        },
        list() {
            return [...specs];
        },
    };
    const invoker: ToolInvoker = {
        async invoke(toolName, args) {
            const impl = impls.get(toolName);
            if (!impl) {
                return { ok: false, error: `工具未实现：${toolName}`, retryable: false };
            }
            return impl(args);
        },
    };
    return { registry, invoker };
}

function defaultNoImpl(
    name: string,
): (args: Record<string, unknown>) => Promise<ToolExecutionResult> {
    return () => Promise.resolve({ ok: false, error: `未注册实现：${name}`, retryable: false });
}

function mergeFlags(config: RuntimeConfig): FeatureFlagDefinition[] {
    const byKey = new Map(DEFAULT_FLAGS.map((f) => [f.key, f]));
    for (const extra of config.flags ?? []) {
        byKey.set(extra.key, extra);
    }
    return [...byKey.values()];
}

function summarizeSession(
    turns: { turn: Turn; steps: import('@mazi/core').Step[] }[],
): string | undefined {
    const last = turns[turns.length - 1];
    if (!last) {
        return undefined;
    }
    const finalSteps = last.steps.filter((s) => s.status === 'ok');
    const lastThought = [...finalSteps].reverse().find((s) => s.kind === 'thinking');
    const content = (lastThought?.payload as { content?: string } | undefined)?.content;
    return content && content.length > 0 ? content.slice(0, 2000) : undefined;
}

/**
 * HarnessRuntime（feature F14，MVP 文档 §3.2/§8 F14）：
 * 装配全部模块后对外暴露 run(input)：Session → Goal → FullLoop → 结果；
 * 事件全部经 DefaultEventBus 落盘 JSONL；用户交互记录即时创建并在 session.ended 完成。
 */
export class HarnessRuntime {
    private readonly bus: DefaultEventBus;
    private readonly memory: SqliteMemoryStore;
    private readonly tools: { registry: ToolRegistry; invoker: ToolInvoker };
    private readonly providers: ReturnType<typeof normalizeProvider>[];
    private readonly router: SimpleRouter;
    private readonly drivers: Map<string, LLMDriver>;
    private readonly flags: FeatureFlagDefinition[];
    private readonly config: RuntimeConfig;
    private readonly workspaceRoot?: string;
    private readonly recorder: UserProfileRecorder;
    private activeSnapshot?: ReturnType<typeof createFlagSnapshot>;

    constructor(config: RuntimeConfig, options: { workspaceRoot?: string } = {}) {
        this.config = config;
        this.workspaceRoot = options.workspaceRoot;
        this.bus = new DefaultEventBus({ eventDir: config.eventDir });
        this.memory = new SqliteMemoryStore(config.dbPath);
        this.tools = buildTools(config, options.workspaceRoot);
        this.providers = config.providers.map((p) => normalizeProvider(p));
        this.router = new SimpleRouter(this.providers);
        const driverRegistry = new DefaultDriverRegistry();
        this.drivers = new Map();
        for (const [i, p] of config.providers.entries()) {
            this.drivers.set(p.id, driverRegistry.build(this.providers[i], p));
        }
        this.flags = mergeFlags(config);
        this.recorder = new UserProfileRecorder(this.bus, this.memory, {
            enabled: () => this.activeSnapshot?.isEnabled('user-profile.enabled') ?? true,
            anonymize: () => this.activeSnapshot?.isEnabled('user-profile.anonymize') ?? false,
        });
        this.recorder.start();
        if (config.consoleEnabled ?? false) {
            this.bus.subscribe({}, new ConsoleSink());
        }
    }

    get eventBus(): EventBus {
        return this.bus;
    }

    get store(): MemoryStore {
        return this.memory;
    }

    async close(): Promise<void> {
        this.recorder.stop();
        this.memory.close();
    }

    /** 用户对会话结果的反馈（CLI 交互 / 调用方显式给出） */
    recordFeedback(sessionId: string, feedback: UserFeedback): void {
        this.bus.emit(
            newHarnessEvent({
                type: 'user.feedback.captured',
                sessionId,
                attributes: { 'user.feedback_type': feedback.type },
                payload: { feedback },
            }),
        );
    }

    async getRecord(sessionId: string): Promise<UserInteractionRecord | undefined> {
        return getRecordBySession(this.memory, sessionId);
    }

    /** 创建并执行（向后兼容：等效 createSession + executeSession） */
    async run(input: string, opts: RunOptions = {}): Promise<RunResult> {
        const created = await this.createSession(input, opts);
        return this.executeSession(created.sessionId);
    }

    /** 创建会话：构建 Goal/Flag 快照并持久化（不执行），记录即时为 recording（webui 会话列表可先出现空会话） */
    async createSession(
        input: string,
        opts: CreateSessionOptions = {},
    ): Promise<{ sessionId: string }> {
        const sessionId = ulid();
        const goal = buildGoal(sessionId, input, this.config, opts.goal);
        if (this.workspaceRoot) {
            goal.constraints.push({
                kind: 'data-boundary',
                rule: `workspace-root:${this.workspaceRoot}`,
                description: '文件权限默认限制在当前工作区内',
            });
        }
        const ctxFlags = { sessionId, userId: opts.userId, goalTags: goal.strategyHints };
        const snapshot = createFlagSnapshot(this.flags, ctxFlags);
        this.activeSnapshot = snapshot;
        const session: Session = {
            sessionId,
            rawIntent: input,
            goal,
            strategyId: 'full-loop',
            state: 'running',
            turns: [],
            flagSnapshot: snapshot,
            createdAt: Date.now(),
        };
        await this.memory.saveSession(session);
        this.bus.emit(
            newHarnessEvent({
                type: 'session.started',
                sessionId,
                attributes: {},
                payload: {
                    rawInput: input,
                    inputTimestamp: Date.now(),
                    userId: opts.userId,
                    flagSnapshot: snapshot.values,
                },
            }),
        );
        await this.bus.flush();
        await this.waitRecordStarted(sessionId);
        return { sessionId };
    }

    /** 执行已创建会话：加载现场（Session+flagSnapshot），复用既有编排管线直至 session.ended */
    async executeSession(sessionId: string): Promise<RunResult> {
        const session = await this.memory.loadSession(sessionId);
        if (!session) {
            throw new Error(`会话不存在：${sessionId}`);
        }
        if (session.endedAt !== undefined) {
            throw new Error(`会话已结束：${sessionId} (outcome=${String(session.outcome)})`);
        }
        const goal = session.goal;
        const snapshot = session.flagSnapshot;
        this.activeSnapshot = snapshot;

        const plannerImpl = new MvpPlanner({
            toolRegistry: this.tools.registry,
            router: this.router,
            bus: this.bus,
            flagSnapshot: snapshot,
            sandboxEnabled: true,
        });
        const plannerAdapter: Planner = {
            plan: async (g: GoalContract) => plannerImpl.plan(g).contracts,
            assembleCapacity: async (turn: Turn) => plannerImpl.assembleCapacity(turn, goal),
        };
        const policy: PolicyEngine = new PolicyEngineImpl({
            goalConstraints: goal.constraints.filter(
                (constraint) => constraint.kind !== 'data-boundary',
            ),
            accumulatedCostUsd: 0,
        });
        const executor = new Executor({
            driverFor: (providerId) => {
                const driver = this.drivers.get(providerId);
                if (!driver) {
                    throw new Error(`无驱动：provider ${providerId}`);
                }
                return driver;
            },
            fallbackModels: () =>
                this.router.candidates(session.turns[0]?.contract.tags ?? ['general']).map((c) => ({
                    model: c.model,
                })),
            policy,
            memory: this.memory,
            bus: this.bus,
            tools: this.tools.invoker,
            meter: new ContextMeter(),
            costs: new CostCalculator(),
            contextWindow: this.config.contextWindow ?? 64000,
            pricing: (model) => {
                const provider = this.providers.find((p) => p.id === model.providerId);
                return (
                    provider?.pricing ?? {
                        currency: 'USD',
                        base: { inputPerMTok: 0, outputPerMTok: 0 },
                        tiers: [],
                        effectiveAt: 0,
                        version: '0.0.0-missing',
                    }
                );
            },
            systemPrompt:
                this.config.systemPrompt ??
                'You are a helpful agent. Follow the plan and finish the task.',
            promptVersion: '0.1.0',
            roundCollector: collectLLMRound,
        });
        const strategy = new FullLoopStrategy();
        const strategyCtx: StrategyContext = {
            session,
            planner: plannerAdapter,
            executor: executor as unknown as StrategyContext['executor'],
            memory: this.memory,
            driver: this.providers[0]
                ? (this.drivers.get(this.providers[0].id) as LLMDriver)
                : ({} as LLMDriver),
            flags: snapshot,
            emit: (event) => this.bus.emit(event),
        };
        let strategyError: Error | undefined;
        try {
            for await (const _event of strategy.run(strategyCtx)) {
                // 事件已同步至 bus；此处仅消费生成器驱动执行
            }
        } catch (error) {
            strategyError = error as Error;
        }
        const turnSteps: { turn: Turn; steps: import('@mazi/core').Step[] }[] = [];
        for (const turn of session.turns) {
            turnSteps.push({ turn, steps: await this.memory.listSteps(turn.turnId) });
        }
        const last = session.turns[session.turns.length - 1];
        const outcome: Session['outcome'] = strategyError
            ? 'failed'
            : last
              ? last.status === 'succeeded'
                  ? 'success'
                  : 'failed'
              : 'failed';
        session.state = outcome === 'success' ? 'succeeded' : 'failed';
        session.outcome = outcome;
        session.endedAt = Date.now();
        const summary = strategyError
            ? `执行异常：${strategyError.message}`
            : summarizeSession(turnSteps);
        const metrics = await this.sessionMetrics(session, turnSteps);
        if (outcome !== 'success') {
            const providerId = session.turns[0]?.capacity?.model?.providerId;
            await this.memory.addFailureRecord({
                recordId: ulid(),
                sessionId,
                failureKind: outcome,
                costUsd: metrics.totalCostUsd,
                providerId,
                tags: [],
                summary: (summary ?? '').slice(0, 240),
                createdAt: session.endedAt,
            });
        }
        await this.memory.saveSession(session);
        this.bus.emit(
            newHarnessEvent({
                type: 'session.ended',
                sessionId,
                payload: {
                    outcome: { status: outcome, summary },
                    metrics,
                    error: strategyError?.message,
                },
            }),
        );
        await this.bus.flush();
        await this.waitRecordCompleted(sessionId);
        return {
            sessionId,
            outcome,
            summary,
            totalCostUsd: metrics.totalCostUsd,
            totalTokens: metrics.totalTokens,
            turnCount: metrics.turnCount,
            record: await this.getRecord(sessionId),
        };
    }

    get currentWorkspaceRoot(): string | undefined {
        return this.workspaceRoot;
    }

    /** recorder 异步创建记录：轮询至记录已生成（recording/completed，上限 500ms） */
    private async waitRecordStarted(sessionId: string): Promise<void> {
        const deadline = Date.now() + 500;
        while (Date.now() < deadline) {
            const record = await this.getRecord(sessionId);
            if (record) {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
    }

    /** recorder 异步完成记录：轮询至 completed（上限 500ms，避免竞态） */
    private async waitRecordCompleted(sessionId: string): Promise<void> {
        const deadline = Date.now() + 500;
        while (Date.now() < deadline) {
            const record = await this.getRecord(sessionId);
            if (record?.status === 'completed') {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
    }

    private async sessionMetrics(
        session: Session,
        turnSteps: { turn: Turn; steps: import('@mazi/core').Step[] }[],
    ): Promise<{
        durationMs: number;
        totalTokens: number;
        totalCostUsd: number;
        turnCount: number;
    }> {
        const durationMs = (session.endedAt ?? Date.now()) - session.createdAt;
        let totalTokens = 0;
        let totalCostUsd = 0;
        for (const { steps } of turnSteps) {
            for (const step of steps) {
                totalTokens +=
                    (step.usage?.vendor.inputTokens ?? 0) + (step.usage?.vendor.outputTokens ?? 0);
                totalCostUsd += step.usage?.cost.totalCostUsd ?? 0;
            }
        }
        return { durationMs, totalTokens, totalCostUsd, turnCount: turnSteps.length };
    }
}
