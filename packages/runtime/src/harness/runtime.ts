import { isAbsolute, relative, resolve } from 'node:path';
import type {
    EventBus,
    Goal,
    LLMProvider,
    NegotiationAnswer,
    PermissionLevel,
    Step,
    Task,
    ToolSchema,
} from '@mazi/core';
import { authz, ulid } from '@mazi/core';
import type { GoalTreeSnapshot, UserBehaviorView, UserQuestionView } from '@mazi/libs';
import { buildQuestionView } from '@mazi/libs';
import { type IterationStore, SqliteIterationStore } from '../analysis/iteration-store.js';
import { IterationTracker } from '../analysis/iteration-tracker.js';
import { TocAnalyst } from '../analysis/toc-analyst.js';
import { SqliteTocStore, type TocStore } from '../analysis/toc-store.js';
import { loadCommandPolicy } from '../auth/command-policy.js';
import type { SkillProvider } from '../capabilities/runtime.js';
import type { RuntimeConfig, ToolCallResult, ToolConfig } from '../config.js';
import {
    type EffectRecord,
    type EffectStore,
    effectPathsForTool,
    MemoryEffectStore,
    newEffectRecord,
    rollbackEffects,
    SqliteEffectStore,
    snapshotFiles,
} from '../effects/effect-store.js';
import { ConsoleSink, DefaultEventBus, newHarnessEvent } from '../events/index.js';
import { StepEventEmitter } from '../events/step-events.js';
import { rollupAcceptance } from '../gts/acceptance.js';
import type { GoalToolInvoker } from '../gts/goal-executor.js';
import {
    applyNegotiationAnswers,
    baselineConditions,
    type ParsedGoalPlan,
    parseGoalParserOutput,
    planNegotiation,
} from '../gts/negotiation.js';
import type { PlannedTask, PlanTool } from '../gts/plan-graph.js';
import {
    type BehaviorMigrationResult,
    type BehaviorStore,
    MemoryBehaviorStore,
    migrateBehaviorJsonlToSqlite,
    SqliteBehaviorStore,
} from '../memory/behavior-store.js';
import {
    type FailureLedgerEntry,
    type FailureLedgerQuery,
    type FailureLedgerStore,
    SqliteFailureLedger,
} from '../memory/failure-ledger.js';
import { type GoalStore, SqliteGoalStore } from '../memory/goal-store.js';
import { MemoryManager, turnsToMemory } from '../memory/memory.js';
import {
    type QuestionLabelInput,
    type QuestionQuery,
    type QuestionStore,
    SqliteQuestionStore,
} from '../memory/question-store.js';
import { type MemoryItem, SqliteMemoryStore } from '../memory/store.js';
import { exportMemoryBundle, importMemoryBundle, type MemoryBundle } from '../memory/transfer.js';
import { BehaviorRecorder } from '../observability/behavior-recorder.js';
import { maziHome, maziPaths } from '../paths.js';
import { modelIdOf, offeringIdOf, providerIdOf } from '../provider/catalog/contract.js';
import type { CatalogService } from '../provider/catalog/service.js';
import { RoundExecutor } from '../provider/index.js';
import { type QuestionClassifier, QuestionLabeler } from '../question/labeler.js';
import { loadQuestionTaxonomy, type QuestionTaxonomy } from '../question/taxonomy.js';
import { type GoalRunResult, runGoalTree } from '../strategy/goal-strategy.js';
import { GENERAL_PROMPT } from '../templates/prompts/general.prompt.js';
import { GOAL_PARSER_PROMPT } from '../templates/prompts/goal-parser.prompt.js';
import { configureTokenizer } from '../token-estimator.js';
import { BUILTIN_TOOL_PRESET } from '../tool-gateway/builtin.js';
import { permissionForTool, RuntimeToolGateway } from '../tool-gateway/permission.js';
import { RuntimePolicyAuditSink } from '../tool-gateway/policy-audit.js';
import { RuntimeToolRegistry } from '../tool-gateway/registry.js';
import { WikiService } from '../wiki/index.js';
import type { FeedbackInput, RunOptions } from './conversation.js';
import { buildLlmProviders, ModelResolver } from './model-resolver.js';
import { type ModelRecoveryFn, RoundRunner } from './round-runner.js';
import { fsReadToolImpl, runCliTool, runShellTool } from './tool-executor.js';

const DEFAULT_AGENT_SYSTEM_PROMPT = GENERAL_PROMPT;

/** 取值兜底：非有限数 → 0（花费回填的 token 字段）。 */
function numberOf(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** GoalRunResult → goal.ended summary（截断 2000 字符） */
function goalRunSummary(result: GoalRunResult): string {
    const last = result.tasks[result.tasks.length - 1];
    if (result.rejected && result.rejected.length > 0) {
        return result.rejected.join(';').slice(0, 2000);
    }
    const summary = last?.finalMessage ?? last?.errorMessage;
    return summary && summary.length > 0 ? summary.slice(0, 2000) : '';
}

/**
 * HarnessRuntime —— Goal/Task/Step 坐标系运行器（C5 收口后为唯一执行面）。
 * createGoalSession（单 Goal 落库：user intent 直接产 Goal）→ executeGoalTree（plan→逐 Task，事实经 GoalStore 留痕）；
 * 事件全部经 DefaultEventBus 落盘 JSONL（按 rootGoalId=运行会话 id 分文件）。
 * 本类只负责生命周期编排与 collaborator 组装；轮次执行归 RoundRunner，
 * 模型/计价解析归 ModelResolver，Step 事件归 StepEventEmitter，工具执行归 tool-executors。
 */
/** triage 超时上限：协商是增强能力，绝不能拖住创建会话（进而拖住主会话输出）。 */
const TRIAGE_TIMEOUT_MS = 10_000;

/** 给 promise 加超时；超时或失败都返回 undefined（调用方回落 fallback，不抛错）。 */
function withTriageTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(undefined), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            () => {
                clearTimeout(timer);
                resolve(undefined);
            },
        );
    });
}

export class HarnessRuntime {
    private readonly bus: DefaultEventBus;
    private readonly goalStoreDb: GoalStore;
    private readonly resolver: ModelResolver;
    /** LLM provider 池（triage 无显式模型时取第一个可用 provider 的默认模型）。 */
    private readonly llmProviders: Map<string, LLMProvider>;
    private readonly stepEvents: StepEventEmitter;
    private readonly roundRunner: RoundRunner;
    /** 项目 wiki 事实层：写工具捕获 + 回合末条目 + 新会话注入（docs/项目wiki设计.md）。 */
    private readonly wiki: WikiService;
    /** TOC/Iterations 独立存储与编排（不进 Goal 坐标系） */
    private readonly tocStore: TocStore;
    private readonly tocAnalysis: TocAnalyst;
    /** 系统迭代记录存储与状态机（分析报告 → 系统改动闭环）。 */
    private readonly iterationStore: IterationStore;
    private readonly iterationTrackerImpl: IterationTracker;
    private readonly config: RuntimeConfig;
    private readonly workspaceRoot?: string;
    /** Human-in-the-loop approval seam; absent → runtime gateway uses the standing ceiling approval. */
    private approvalSeam?: authz.ApprovalSeam;
    /** 进程级 session/workspace 审批授权：绑定具体操作，跨 run 复用。 */
    private readonly approvalStore = new authz.InMemoryApprovalStore();
    /** 命令分类规则（运行时从配置加载；未命中规则走 shell.run 默认）。 */
    private readonly commandPolicy: authz.CommandPolicy;
    /** Versioned catalogue; each run pins one immutable snapshot. */
    private readonly toolRegistry: RuntimeToolRegistry;
    /** 待执行 Session 的 Conversation id（session 作用域审批匹配用） */
    private readonly pendingSessionId = new Map<string, string>();
    /** 长期记忆调度组合根（有 dbPath 时跨进程持久化）。 */
    private readonly memoryManager: MemoryManager;
    private readonly persistentMemoryStore?: SqliteMemoryStore;
    /** Reversible workspace effect journal (snapshots only explicitly scoped file writes). */
    private readonly effectStore: EffectStore;
    /** 用户行为流权威库（SQLite；缺 dbPath 时进程内）。 */
    private readonly behaviorStore: BehaviorStore;
    /** 用户行为指令记录器（输入/反馈/审批；行为流 append-only）。 */
    private readonly behaviorRecorder: BehaviorRecorder;
    /** 用户问题与标签存储（问题实体 + 标签；与行为库同一 DB 文件）。 */
    private readonly questionStore: QuestionStore;
    /** 问题标注器（规则同步 + LLM 精标 seam）。 */
    private readonly questionLabeler: QuestionLabeler;
    /** 问题标签分类法（注册表）。 */
    private readonly questionTaxonomy: QuestionTaxonomy;
    /** 失败分类账（Task 终态失败事实；只追加）。 */
    private readonly failureLedger: FailureLedgerStore;
    /** 待执行 Session 的推理强度（create → execute 之间传递） */
    private readonly pendingReasoning = new Map<string, string>();
    /** 待执行 Session 的模型 id（create → execute 之间传递） */
    private readonly pendingModel = new Map<string, string>();
    /** 待执行 Session 的系统提示片段（Feature 解析结果，create → execute 之间传递） */
    private readonly pendingPromptFragment = new Map<string, string>();
    /** 待执行 Session 的技能集合覆盖（显式给出则覆盖全局挂载） */
    private readonly pendingSkills = new Map<string, readonly string[]>();
    /** 待执行 Session 的工具白名单收窄（与配置白名单取交集） */
    private readonly pendingAllowedTools = new Map<string, readonly string[]>();
    /** Optional caller/model plan proposal; Task identity is created by the harness. */
    private readonly pendingPlanProposal = new Map<string, readonly PlannedTask[]>();
    private readonly pendingMemoryContext = new Map<
        string,
        {
            conversationId?: string;
            userId?: string;
            workspaceId?: string;
            projectId?: string;
        }
    >();
    /** 待执行 Session 的开关审计（flag.evaluated：值 + 求值痕迹） */
    private readonly pendingFlags = new Map<
        string,
        {
            values: Record<string, boolean>;
            trace: Array<{ id: string; enabled: boolean; source: string }>;
        }
    >();
    /** 运行中的 Goal 树 → 协作式停止控制器（stop 生效、进程内互斥）。 */
    private readonly running = new Map<string, AbortController>();
    /** JSONL→DB 迁移单飞（构造器与显式调用共享同一 Promise）。 */
    private behaviorMigration?: Promise<BehaviorMigrationResult>;
    /** 接入后的目录账本（花费回填等一次性遍历用）。 */
    private catalogService?: CatalogService;
    /** 已挂载技能包的工具面（apps/api 注入；缺省 = 无技能）。 */
    private skillProvider?: SkillProvider;

    constructor(config: RuntimeConfig, options: RunOptions = {}) {
        this.config = config;
        this.commandPolicy = loadCommandPolicy(
            config.authCommandPolicyFile ?? maziPaths().authCommandPolicyFile,
        ).policy;
        this.toolRegistry = new RuntimeToolRegistry([...BUILTIN_TOOL_PRESET, ...config.tools]);
        configureTokenizer(config.tokenizerEncoding);
        this.workspaceRoot = options.workspaceRoot;
        this.bus = new DefaultEventBus({ eventDir: config.eventDir });
        // 问题/行为统一入 SQLite 权威库；JSONL 目录降级为导出/迁移来源。
        this.behaviorStore =
            config.dbPath !== undefined
                ? new SqliteBehaviorStore(config.dbPath)
                : new MemoryBehaviorStore();
        this.behaviorRecorder = new BehaviorRecorder(this.behaviorStore);
        this.questionStore = new SqliteQuestionStore(config.dbPath ?? ':memory:');
        this.questionTaxonomy = loadQuestionTaxonomy(
            config.questionTaxonomyFile ?? maziPaths().questionTaxonomyFile,
        );
        this.questionLabeler = new QuestionLabeler(this.questionTaxonomy, (questionId, labels) =>
            this.questionStore.addLabels(questionId, labels),
        );
        if (config.behaviorDir !== undefined && config.dbPath !== undefined) {
            void this.migrateBehaviorStream().catch((error: unknown) => {
                process.stderr.write(`behavior migration error: ${String(error)}\n`);
            });
        }
        this.failureLedger = new SqliteFailureLedger(config.dbPath ?? ':memory:');
        this.bus.subscribe(
            { types: ['approval.requested', 'approval.granted', 'approval.cancelled'] },
            {
                id: 'behavior-recorder',
                handle: (event) => {
                    void this.behaviorRecorder
                        .handleApprovalEvent(event)
                        .catch((error: unknown) => {
                            process.stderr.write(`behavior capture error: ${String(error)}\n`);
                        });
                },
            },
        );
        this.goalStoreDb = new SqliteGoalStore(config.dbPath ?? ':memory:');
        this.persistentMemoryStore =
            config.dbPath !== undefined ? new SqliteMemoryStore(config.dbPath) : undefined;
        this.memoryManager = new MemoryManager(
            this.persistentMemoryStore !== undefined ? { store: this.persistentMemoryStore } : {},
        );
        this.effectStore =
            config.dbPath !== undefined
                ? new SqliteEffectStore(config.dbPath)
                : new MemoryEffectStore();
        this.llmProviders = buildLlmProviders(config, options);
        this.resolver = new ModelResolver(config, this.llmProviders);
        this.stepEvents = new StepEventEmitter(this.bus);
        this.wiki = new WikiService({
            home: maziHome(),
            ...(options.workspaceRoot !== undefined ? { workspace: options.workspaceRoot } : {}),
            ...(config.wiki ?? {}),
        });
        this.roundRunner = new RoundRunner({
            bus: this.bus,
            executor: new RoundExecutor(),
            resolver: this.resolver,
        });
        this.tocStore = new SqliteTocStore(config.dbPath ?? ':memory:');
        this.tocAnalysis = new TocAnalyst({
            store: this.tocStore,
            snapshotOf: (rootGoalId) => this.goalSnapshot(rootGoalId),
            requestRound: (rootGoalId, ctx, reasoningLevel) =>
                this.roundRunner.requestRound(rootGoalId, ctx, reasoningLevel),
            resolveModelChoice: (modelId) => this.resolver.resolveModelChoice(modelId),
        });
        this.iterationStore = new SqliteIterationStore(config.dbPath ?? ':memory:');
        this.iterationTrackerImpl = new IterationTracker({ store: this.iterationStore });
        if (config.consoleEnabled ?? false) {
            this.bus.subscribe({}, new ConsoleSink());
        }
    }

    get eventBus(): EventBus {
        return this.bus;
    }

    /** 接入目录与账本：此后每轮 LLM 调用按钉死的 offering 价目追加 UsageRecord。 */
    setCatalog(service: CatalogService): void {
        this.catalogService = service;
        this.roundRunner.setCatalog(service);
    }

    /** 接入已挂载技能包：工具并入每次 Goal 的执行工具面，档位按包 ceiling 收敛。 */
    setSkillProvider(provider?: SkillProvider): void {
        this.skillProvider = provider;
    }

    /**
     * 回填历史花费凭证：把已落库 Step 的 vendor 原始用量（`usage.raw`）按当前目录价目结算进账本。
     * 凭证 id = `bf:<stepId>`，重复调用幂等；目录未收录/无价的模型跳过（目录是权威）。
     */
    async backfillUsage(): Promise<{ recorded: number; skipped: number }> {
        const service = this.catalogService;
        if (service === undefined) return { recorded: 0, skipped: 0 };
        const existing = new Set((await service.usageRecords()).map((record) => record.id));
        const steps = await this.goalStoreDb.listAllSteps();
        let recorded = 0;
        let skipped = 0;
        for (const step of steps) {
            const raw = (step.usage as { raw?: Record<string, unknown> } | undefined)?.raw;
            const providerId = typeof raw?.providerId === 'string' ? raw.providerId : undefined;
            const modelId = typeof raw?.modelId === 'string' ? raw.modelId : undefined;
            if (providerId === undefined || modelId === undefined) continue;
            const recordId = `bf:${step.stepId}`;
            if (existing.has(recordId)) {
                skipped += 1;
                continue;
            }
            try {
                const pin = service.pin(offeringIdOf(providerIdOf(providerId), modelIdOf(modelId)));
                await service.settle(
                    pin,
                    {
                        inputTokens: numberOf(raw?.inputTokens),
                        outputTokens: numberOf(raw?.outputTokens),
                        cacheReadTokens: numberOf(raw?.cachedInputTokens),
                    },
                    step.startedAt,
                    recordId,
                );
                existing.add(recordId);
                recorded += 1;
            } catch {
                skipped += 1;
            }
        }
        return { recorded, skipped };
    }

    /** 接入模型恢复：模型名被厂商拒绝时重同步并换模重试一次（llm.error 事件后自愈）。 */
    setModelRecovery(fn: ModelRecoveryFn): void {
        this.roundRunner.setRecovery(fn);
    }

    /** 接入人审审批 seam；缺省时运行时网关回退到 ceiling 常设授权。 */
    setApprovalSeam(seam: authz.ApprovalSeam): void {
        this.approvalSeam = seam;
    }

    /** 问题标签分类法（注册表；GET /api/question-taxonomy 消费）。 */
    getQuestionTaxonomy(): QuestionTaxonomy {
        return this.questionTaxonomy;
    }

    /** 对某问题重跑 LLM 精标（需已注入分类器）；返回是否命中该问题。 */
    async classifyQuestion(questionId: string): Promise<boolean> {
        const record = await this.questionStore.get(questionId);
        if (record === undefined) return false;
        await this.questionLabeler.classify(questionId, record.text);
        return true;
    }

    /** 注入 LLM 问题分类器（可选；不注入则仅规则预标注）。输出经注册表校验后落库。 */
    setQuestionClassifier(classifier: QuestionClassifier): void {
        this.questionLabeler.setClassifier(classifier);
    }

    /** Goal/Task/Step 存储（Goal 会话审计/级联删除） */
    get goalStore(): GoalStore {
        return this.goalStoreDb;
    }

    /** TOC 冻结、独立分析、反馈与 Iterations 聚合（独立于 Goal 坐标系） */
    get tocAnalyst(): TocAnalyst {
        return this.tocAnalysis;
    }

    /** 系统迭代记录（分析报告 → 系统改动闭环；版本快照由 API 层注入）。 */
    get iterationTracker(): IterationTracker {
        return this.iterationTrackerImpl;
    }

    get currentWorkspaceRoot(): string | undefined {
        return this.workspaceRoot;
    }

    async close(): Promise<void> {
        this.goalStoreDb.close();
        this.persistentMemoryStore?.close();
        this.effectStore.close();
        this.tocStore.close();
        this.iterationStore.close();
        this.behaviorRecorder.close();
        this.questionStore.close();
        this.failureLedger.close();
    }

    /** 创建 Goal 会话（单 Goal：user intent 直接产 Goal）并持久化；发 goal.started */
    async createGoalSession(
        input: string,
        opts: RunOptions = {},
    ): Promise<{ rootGoalId: string; goalId: string }> {
        const rootGoalId = ulid();
        if (opts.conversationId !== undefined) {
            this.pendingSessionId.set(rootGoalId, opts.conversationId);
        }
        const workspaceId = opts.workspaceRoot ?? this.workspaceRoot;
        const memoryContext = {
            ...(opts.conversationId !== undefined ? { conversationId: opts.conversationId } : {}),
            ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
            ...(workspaceId !== undefined ? { workspaceId } : {}),
        };
        this.pendingMemoryContext.set(rootGoalId, memoryContext);
        if (opts.history !== undefined && opts.history.length > 0) {
            await this.memoryManager.remember(
                turnsToMemory(opts.history, {
                    rootGoalId,
                    ...memoryContext,
                    provenance: { source: 'user', confidence: 'confirmed', trustTier: 'T1' },
                }),
            );
        }
        if (opts.reasoningLevel) {
            this.pendingReasoning.set(rootGoalId, opts.reasoningLevel);
        }
        if (opts.modelId) {
            this.pendingModel.set(rootGoalId, opts.modelId);
        }
        if (opts.promptFragment !== undefined && opts.promptFragment.length > 0) {
            this.pendingPromptFragment.set(rootGoalId, opts.promptFragment);
        }
        if (opts.skillIds !== undefined) {
            this.pendingSkills.set(rootGoalId, opts.skillIds);
        }
        if (opts.allowedTools !== undefined) {
            this.pendingAllowedTools.set(rootGoalId, opts.allowedTools);
        }
        if (opts.planProposal !== undefined) {
            this.pendingPlanProposal.set(
                rootGoalId,
                opts.planProposal.map((task) => ({
                    ...task,
                    goalId: task.goalId ?? (rootGoalId as NonNullable<typeof task.goalId>),
                })),
            );
        }
        if (opts.flagOverrides !== undefined) {
            this.pendingFlags.set(rootGoalId, {
                values: { ...opts.flagOverrides },
                trace: (opts.flagTrace ?? []).map((step) => ({ ...step })),
            });
        }
        const ceiling =
            opts.permissionCeiling ?? this.config.goal?.permissionCeiling ?? 'read-only';
        // 运行设置 → 契约：预算与终止策略在冻结时刻落进 GoalContract，执行期由
        // runGoalTree/executeTask 读取（UI 的「预算 / 最大步数」不再是空控件）。
        const budgetAllocation =
            opts.maxCostUsd !== undefined ? { maxCostUsd: opts.maxCostUsd } : {};
        const terminationPolicy = opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {};
        // 契约先按基线冻结并立即建会话：triage 是"增强"，绝不占用创建请求的关键路径
        // （否则用户消息要等一次模型轮次才显示，主会话看起来卡住）。
        const goal: Goal = {
            goalId: rootGoalId,
            origin: { kind: 'human' },
            statement: input,
            contract: {
                // 基线条款机械可判（check 由评估器执行）；triage 落地后追加语义条款
                successConditions: baselineConditions(),
                failureConditions: [],
                forbiddenResources: [],
                budget: budgetAllocation,
                terminationPolicy,
                riskProfile: {
                    hasIrreversibleActions: false,
                    touchesNetwork: false,
                    touchesExternalApi: false,
                },
            },
            permissionCeiling: ceiling,
            budget: budgetAllocation,
            status: 'active',
            createdAt: Date.now(),
        };
        await this.goalStoreDb.saveGoal(goal);
        const recorded = await this.behaviorRecorder.recordInput(rootGoalId, input, {
            ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
            ...(opts.conversationId !== undefined ? { conversationId: opts.conversationId } : {}),
        });
        const question = recorded[0];
        if (question !== undefined) {
            await this.questionLabeler.label(`${rootGoalId}:${question.ts}`, input);
        }
        this.bus.emit(
            newHarnessEvent({
                type: 'goal.started',
                rootGoalId,
                goalId: rootGoalId,
                attributes: {},
                payload: {
                    rawInput: input,
                    inputTimestamp: Date.now(),
                    userId: opts.userId ?? undefined,
                },
            }),
        );
        await this.bus.flush();
        // 异步 triage：不 await。落地后以「读改写」合并进契约（对正在跑的 run 只做加法）。
        if (opts.parseIntent === true) {
            this.scheduleIntentTriage(rootGoalId, input, opts);
        }
        return { rootGoalId, goalId: rootGoalId };
    }

    /** 异步 triage：失败/超时只是不协商，绝不影响会话创建与执行。 */
    private scheduleIntentTriage(rootGoalId: string, statement: string, opts: RunOptions): void {
        void this.applyIntentTriage(rootGoalId, statement, opts).catch(() => undefined);
    }

    /**
     * triage 结果落地：读改写当前 Goal，只在尚未有协商结论时合并（幂等）。
     * 追加的语义条款是纯增量，不会让已生成的 Task.acceptance / Step 归因失效。
     */
    private async applyIntentTriage(
        rootGoalId: string,
        statement: string,
        opts: RunOptions,
    ): Promise<void> {
        const parsed = await this.parseIntent(statement, rootGoalId, opts);
        const plan = planNegotiation(parsed);
        const goal = await this.goalStoreDb.loadGoal(rootGoalId);
        if (goal === undefined || goal.negotiation !== undefined) return;
        const added = plan.conditions.filter((condition) => condition.checkType === 'semantic');
        goal.contract = {
            ...goal.contract,
            successConditions: [...goal.contract.successConditions, ...added],
        };
        goal.negotiation = plan.negotiation;
        await this.goalStoreDb.saveGoal(goal);
        if (plan.negotiation.route !== 'negotiate' && plan.negotiation.route !== 'escalate') return;
        this.bus.emit(
            newHarnessEvent({
                type: 'goal.negotiation.requested',
                rootGoalId,
                goalId: rootGoalId,
                payload: {
                    route: plan.negotiation.route,
                    triggers: plan.negotiation.triggers,
                    questions: plan.negotiation.questions,
                    defaultPath: plan.negotiation.defaultPath ?? [],
                    ...(plan.negotiation.escalation !== undefined
                        ? { escalation: plan.negotiation.escalation }
                        : {}),
                },
            }),
        );
        await this.bus.flush();
    }

    /**
     * triage：把用户输入交给 goal-parser 模板判定路由（direct / confirmed / negotiate / escalate）。
     * 没有可用 provider 时返回 undefined（调用方走 fallback），不额外制造失败噪声。
     */
    private async parseIntent(
        statement: string,
        rootGoalId: string,
        opts: RunOptions,
    ): Promise<ParsedGoalPlan | undefined> {
        if (opts.parseIntent !== true) return undefined;
        const model = this.resolver.resolveModelChoice(opts.modelId) ?? this.triageModel();
        if (model === undefined) return undefined;
        // triage 是"增强"，不能成为主流程的阻塞点：超时/失败/无输出一律回落默认执行
        const round = await withTriageTimeout(
            this.roundRunner.requestRound(
                rootGoalId,
                {
                    model,
                    messages: [{ role: 'user', content: [{ type: 'text', text: statement }] }],
                    systemPrompt: GOAL_PARSER_PROMPT,
                    tools: [],
                },
                opts.reasoningLevel,
            ),
            TRIAGE_TIMEOUT_MS,
        );
        if (round === undefined) return undefined;
        return parseGoalParserOutput(round.text);
    }

    /**
     * triage 用的模型：无显式 modelId 时取 provider 池里第一个有默认模型的 provider。
     * 没有任何可用 provider 时返回 undefined（不协商，走 fallback）。
     */
    private triageModel(): { providerId: string; modelId: string } | undefined {
        for (const [providerId, provider] of this.llmProviders) {
            const modelId = provider.defaultModel || provider.models?.[0]?.id;
            if (modelId !== undefined && modelId.length > 0) {
                return { providerId, modelId };
            }
        }
        return undefined;
    }

    /**
     * 协商答复 → 修订并重新冻结契约（goal.contract-revised 是唯一合法迁移记录）。
     * 只在 goal 处于 blocked 且未经答复时受理；重复调用按幂等处理。
     */
    async negotiateGoal(
        rootGoalId: string,
        answers: readonly NegotiationAnswer[],
    ): Promise<{ goalId: string; revision: number; resolved: boolean }> {
        const goal = await this.goalStoreDb.loadGoal(rootGoalId);
        if (goal === undefined) throw new Error(`Goal 不存在：${rootGoalId}`);
        const current = goal.negotiation;
        if (
            current === undefined ||
            (current.route !== 'negotiate' && current.route !== 'escalate')
        ) {
            throw new Error(`该 Goal 未经协商（route=${current?.route ?? 'none'}）：${rootGoalId}`);
        }
        const applied = applyNegotiationAnswers(current, answers, goal.contract.successConditions);
        goal.contract = { ...goal.contract, successConditions: applied.conditions };
        goal.negotiation = applied.negotiation;
        if (goal.status === 'blocked') goal.status = 'active';
        await this.goalStoreDb.saveGoal(goal);
        this.bus.emit(
            newHarnessEvent({
                type: 'goal.contract-revised',
                rootGoalId,
                goalId: goal.goalId,
                payload: {
                    fromRevision: current.revision,
                    toRevision: applied.negotiation.revision,
                    answers: applied.negotiation.answers,
                    conditions: applied.conditions.map((condition) => ({
                        id: condition.id,
                        checkType: condition.checkType,
                        ...(condition.description !== undefined
                            ? { description: condition.description }
                            : {}),
                    })),
                },
            }),
        );
        await this.bus.flush();
        return {
            goalId: goal.goalId,
            revision: applied.negotiation.revision,
            resolved: applied.negotiation.resolved,
        };
    }

    /** 执行 Goal（plan → 逐 Task；事实全部经 goalStore 留痕）；发 goal.ended / run.aborted */
    async executeGoalTree(
        rootGoalId: string,
        options: { resume?: boolean } = {},
    ): Promise<GoalRunResult> {
        const goals = await this.goalStoreDb.listGoalsByRoot(rootGoalId);
        if (goals.length === 0) {
            throw new Error(`Goal 树不存在：${rootGoalId}`);
        }
        const resume = options.resume === true;
        // 上下文 delta 基线由每个 Task 的 ContextManager 自己持有，无需跨 run 重置。
        const reasoningLevel = this.pendingReasoning.get(rootGoalId);
        this.pendingReasoning.delete(rootGoalId);
        const modelId = this.pendingModel.get(rootGoalId);
        this.pendingModel.delete(rootGoalId);
        const promptFragment = this.pendingPromptFragment.get(rootGoalId);
        this.pendingPromptFragment.delete(rootGoalId);
        const requestedSkills = this.pendingSkills.get(rootGoalId);
        this.pendingSkills.delete(rootGoalId);
        const allowedToolsOverride = this.pendingAllowedTools.get(rootGoalId);
        this.pendingAllowedTools.delete(rootGoalId);
        const planProposal = this.pendingPlanProposal.get(rootGoalId);
        this.pendingPlanProposal.delete(rootGoalId);
        const memoryContext = this.pendingMemoryContext.get(rootGoalId) ?? {};
        this.pendingMemoryContext.delete(rootGoalId);
        const flags = this.pendingFlags.get(rootGoalId);
        this.pendingFlags.delete(rootGoalId);
        const model = this.resolver.resolveModelChoice(modelId);
        const sessionId = this.pendingSessionId.get(rootGoalId);
        this.pendingSessionId.delete(rootGoalId);
        const rootGoal = goals.find((goal) => goal.goalId === rootGoalId) ?? goals[0];
        const goalId = rootGoal?.goalId ?? rootGoalId;
        const exec = this.goalExecutionConfig(
            rootGoalId,
            goalId,
            rootGoal?.permissionCeiling ?? this.config.goal?.permissionCeiling ?? 'read-only',
            sessionId,
            allowedToolsOverride,
        );
        this.bus.emit(
            newHarnessEvent({
                type: 'toolset.assembled',
                rootGoalId,
                goalId,
                attributes: { 'harness.level': 'info' },
                payload: {
                    version: exec.toolsetVersion,
                    digest: exec.toolsetDigest,
                    tools: exec.allowedTools,
                },
            }),
        );
        // 项目 wiki：先建兜底 diff 基线并确保项目概览快照存在，再读一次用于注入。
        await this.wiki.beginRun();
        const wikiFragment = this.wiki.promptFragment();
        // 挂载是用户级开关；每次运行在边界发能力事件，审计锚定本次 run。
        // 运行级 skillIds 覆盖（实验臂）优先于全局挂载状态。
        const skillIds = requestedSkills ?? this.skillProvider?.mounted() ?? [];
        for (const skillId of skillIds) {
            this.emitSkillEvent('capability.activated', skillId, rootGoalId, goalId);
        }
        if (flags !== undefined && Object.keys(flags.values).length > 0) {
            this.emitFlagEvent(rootGoalId, goalId, flags.values, flags.trace);
        }
        const controller = new AbortController();
        this.running.set(rootGoalId, controller);
        let result: GoalRunResult;
        try {
            result = await runGoalTree(
                {
                    store: this.goalStoreDb,
                    requestRound: (ctx) =>
                        this.roundRunner.requestRound(rootGoalId, ctx, reasoningLevel, sessionId),
                    systemPrompt: this.systemPromptWithSkills(
                        rootGoalId,
                        goalId,
                        requestedSkills,
                        combinePromptFragments(promptFragment, wikiFragment),
                    ),
                    tools: exec.tools,
                    invoker: exec.invoker,
                    allowedTools: exec.allowedTools,
                    memory: this.memoryManager,
                    memoryQuery: {
                        rootGoalId,
                        ...memoryContext,
                    },
                    memoryWriteContext: memoryContext,
                    ...(planProposal !== undefined ? { planProposal } : {}),
                    planTools: exec.planTools,
                    ...(model ? { model } : {}),
                    ...(this.workspaceRoot !== undefined
                        ? { workspaceRoot: this.workspaceRoot }
                        : {}),
                    ...(resume ? { resume: true } : {}),
                    signal: controller.signal,
                    onStep: (step) => {
                        this.stepEvents.emitStep(rootGoalId, step);
                        this.wiki.observeStep(step);
                    },
                    onPlan: (taskCount, digest, rejected) => {
                        this.bus.emit(
                            newHarnessEvent({
                                type: rejected === undefined ? 'plan.created' : 'plan.invalid',
                                rootGoalId,
                                goalId,
                                attributes: {
                                    'harness.level': rejected === undefined ? 'info' : 'warn',
                                },
                                payload:
                                    rejected === undefined
                                        ? { taskCount, digest }
                                        : { taskCount, rejected },
                            }),
                        );
                    },
                },
                goals,
            );
        } finally {
            this.running.delete(rootGoalId);
            for (const skillId of skillIds) {
                this.emitSkillEvent('capability.deactivated', skillId, rootGoalId, goalId);
            }
        }
        const aborted = result.tasks.some((outcome) => outcome.reason === 'aborted');
        // Settle the Goal entities so the persisted tree/snapshot no longer reports
        // every active goal as 'active' after the run has finished. Aborted runs stay
        // resumable (Goal.status='aborted') instead of being marked failed.
        // 没有 TaskOutcome 的 Goal（blocked 待协商 / direct 直答 / pending）保持原状态：
        // 它们根本没进入本次执行，不能被一次「空运行」改写成 succeeded。
        const outcomeByGoal = new Map(
            result.tasks.map((outcome) => [outcome.task.goalId, outcome]),
        );
        for (const goal of goals) {
            const outcome = outcomeByGoal.get(goal.goalId);
            if (outcome === undefined) continue;
            // 读改写最新行：异步 triage 可能刚把协商结论/语义条款写进同一个 Goal，
            // 不能用运行开始时读到的旧副本整体覆盖。
            const latest = (await this.goalStoreDb.loadGoal(goal.goalId)) ?? goal;
            latest.status =
                outcome.reason === 'aborted' ? 'aborted' : outcome.ok ? 'succeeded' : 'failed';
            await this.goalStoreDb.saveGoal(latest);
            // 契约满足度落事件：Goal.status 是 executor 的成败，这里才是评估器的机械判定，
            // 两者分开（裁决 D8），审计可据此回答「契约到底被满足了没有」。
            const evaluation = rollupAcceptance(
                latest.contract.successConditions.map((condition) => condition.id),
                [outcome.task.acceptanceResult],
            );
            this.bus.emit(
                newHarnessEvent({
                    type: 'goal.contract-evaluated',
                    rootGoalId,
                    goalId: goal.goalId,
                    attributes: { 'harness.level': 'info' },
                    payload: evaluation,
                }),
            );
            await this.bus.flush();
        }
        // 终态失败写入分类账；aborted 是协作式停止、可恢复，不记失败。
        for (const outcome of result.tasks) {
            if (outcome.ok || outcome.reason === 'aborted') continue;
            await this.failureLedger.add({
                failureId: ulid(),
                sessionId: rootGoalId,
                goalId: outcome.task.goalId,
                taskId: outcome.task.taskId,
                kind: outcome.reason,
                ...(model !== undefined
                    ? { providerId: model.providerId, modelId: model.modelId }
                    : {}),
                ...(outcome.errorMessage !== undefined ? { summary: outcome.errorMessage } : {}),
                createdAt: Date.now(),
            });
        }
        if (aborted) {
            this.bus.emit(
                newHarnessEvent({
                    type: 'run.aborted',
                    rootGoalId,
                    payload: { reason: 'user-stop' },
                }),
            );
        } else {
            this.bus.emit(
                newHarnessEvent({
                    type: 'goal.ended',
                    rootGoalId,
                    payload: {
                        outcome: {
                            status: result.ok ? 'success' : 'failed',
                            summary: goalRunSummary(result),
                        },
                        error: result.rejected?.join(';'),
                    },
                }),
            );
        }
        // 回合收尾：把本次运行的改动写成『时间 | 功能级改动』条目（无改动零成本）。
        await this.wiki.flushRun({
            ...(sessionId !== undefined ? { sessionId } : {}),
            ...(rootGoal?.statement !== undefined && rootGoal.statement.length > 0
                ? { userRequest: rootGoal.statement }
                : {}),
        });
        await this.bus.flush();
        return result;
    }

    /** 请求停止运行中的 Goal 树；返回是否命中在跑的运行（不改变已落库事实）。 */
    stopGoalTree(rootGoalId: string): boolean {
        const controller = this.running.get(rootGoalId);
        if (controller === undefined) return false;
        controller.abort();
        return true;
    }

    /** 该 Goal 树当前是否在本实例执行中。 */
    isGoalRunning(rootGoalId: string): boolean {
        return this.running.has(rootGoalId);
    }

    /**
     * 恢复执行被停止的 Goal 树：复用 aborted/active Task，从已落库 Step 重放上下文后继续。
     * reasoningLevel/modelId 为本轮恢复的模型选择（缺省沿用 provider 默认）。
     */
    async resumeGoalTree(
        rootGoalId: string,
        options: {
            reasoningLevel?: string;
            modelId?: string;
            promptFragment?: string;
            skillIds?: readonly string[];
            allowedTools?: readonly string[];
            flagOverrides?: Readonly<Record<string, boolean>>;
            flagTrace?: readonly { id: string; enabled: boolean; source: string }[];
        } = {},
    ): Promise<GoalRunResult> {
        if (options.reasoningLevel !== undefined) {
            this.pendingReasoning.set(rootGoalId, options.reasoningLevel);
        }
        if (options.modelId !== undefined) {
            this.pendingModel.set(rootGoalId, options.modelId);
        }
        // 恢复同样携带运行级覆盖（Feature / 技能 / 工具），保证中断前后条件一致。
        if (options.promptFragment !== undefined && options.promptFragment.length > 0) {
            this.pendingPromptFragment.set(rootGoalId, options.promptFragment);
        }
        if (options.skillIds !== undefined) {
            this.pendingSkills.set(rootGoalId, options.skillIds);
        }
        if (options.allowedTools !== undefined) {
            this.pendingAllowedTools.set(rootGoalId, options.allowedTools);
        }
        if (options.flagOverrides !== undefined) {
            this.pendingFlags.set(rootGoalId, {
                values: { ...options.flagOverrides },
                trace: (options.flagTrace ?? []).map((step) => ({ ...step })),
            });
        }
        this.bus.emit(newHarnessEvent({ type: 'run.resumed', rootGoalId, payload: {} }));
        await this.bus.flush();
        return this.executeGoalTree(rootGoalId, { resume: true });
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
        const { snapshotGoalTree } = await import('../observability/goal-snapshot.js');
        const snapshot = snapshotGoalTree(rootGoalId, goals, tasks, steps);
        const behaviors = await this.behaviorRecorder.list(rootGoalId);
        return behaviors.length > 0 ? { ...snapshot, behaviors } : snapshot;
    }

    /** 用户对 root goal 结果的反馈（CLI/调用方显式给出）：先落行为流，再发事件。 */
    async recordFeedback(rootGoalId: string, feedback: FeedbackInput): Promise<void> {
        await this.behaviorRecorder.recordFeedback(rootGoalId, feedback);
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

    /** 读取会话的用户行为指令（Step 投影输入；见 @mazi/libs projectBehaviorTimeline）。 */
    listBehaviors(rootGoalId: string): Promise<UserBehaviorView[]> {
        return this.behaviorRecorder.list(rootGoalId);
    }

    /** 问题视图（含有效标签）——apps/api 问题查询消费。 */
    async listQuestions(query: QuestionQuery = {}): Promise<UserQuestionView[]> {
        const records = await this.questionStore.list(query);
        const labels = await this.questionStore.listLabelsFor(
            records.map((record) => record.questionId),
        );
        return records.map((record) =>
            buildQuestionView(record, labels.get(record.questionId) ?? []),
        );
    }

    /** 单条问题视图（无则 undefined）。 */
    async getQuestion(questionId: string): Promise<UserQuestionView | undefined> {
        const record = await this.questionStore.get(questionId);
        if (record === undefined) return undefined;
        return buildQuestionView(record, await this.questionStore.listLabels(questionId));
    }

    /** 追加标签（append-only；user 覆盖由 effectiveLabels 合并规则承担）。 */
    addQuestionLabels(questionId: string, labels: readonly QuestionLabelInput[]): Promise<void> {
        return this.questionStore.addLabels(questionId, labels);
    }

    /**
     * 一次性把旧 JSONL 行为流导入 SQLite 权威库（幂等；JSONL 原文件保留为证据）。
     * 启动时构造器已 fire-and-forget 调用一次；测试可直接 await。
     */
    migrateBehaviorStream(): Promise<BehaviorMigrationResult> {
        if (this.behaviorMigration !== undefined) return this.behaviorMigration;
        if (
            this.config.behaviorDir === undefined ||
            !(this.behaviorStore instanceof SqliteBehaviorStore)
        ) {
            this.behaviorMigration = Promise.resolve({ partitions: 0, imported: 0 });
            return this.behaviorMigration;
        }
        this.behaviorMigration = migrateBehaviorJsonlToSqlite(
            this.config.behaviorDir,
            this.behaviorStore,
        );
        return this.behaviorMigration;
    }

    /** 历史提问回填（采集上线前的 run；写入一条 derived input 并规则标注）。 */
    async backfillBehaviorInput(
        rootGoalId: string,
        run: { input: string; createdAt: number },
    ): Promise<UserBehaviorView[]> {
        const written = await this.behaviorRecorder.backfillInput(rootGoalId, run);
        const first = written[0];
        if (first !== undefined) {
            await this.questionLabeler.label(`${rootGoalId}:${first.ts}`, run.input);
        }
        return written;
    }

    /** 清除某运行会话的行为流（治理删除）。 */
    clearBehaviors(rootGoalId: string): Promise<void> {
        return this.behaviorRecorder.clear(rootGoalId);
    }

    /** 失败分类账查询（apps/api GET /api/ledger 消费）。 */
    listFailures(query: FailureLedgerQuery = {}): Promise<FailureLedgerEntry[]> {
        return this.failureLedger.list(query);
    }

    /** 级联删除某运行会话的失败记录（Conversation 删除用）。 */
    deleteFailures(rootGoalId: string): Promise<void> {
        return this.failureLedger.deleteByRoot(rootGoalId);
    }

    /**
     * Goal 执行的工具面：内置 CLI 预设 + config.tools → 经 v2 ToolGateway 判权的
     * ToolSchema/执行器/白名单。supply 视图只暴露当前 permissionCeiling 允许的工具；
     * 白名单缺省 = 全部可见工具；显式空数组 = 纯对话（不注入工具 schema）。
     */
    private goalExecutionConfig(
        rootGoalId: string,
        goalId: string,
        level: PermissionLevel,
        sessionId?: string,
        allowedToolsOverride?: readonly string[],
    ): {
        tools: ToolSchema[];
        invoker: GoalToolInvoker;
        allowedTools: string[];
        planTools: PlanTool[];
        toolsetVersion: number;
        toolsetDigest: string;
    } {
        // Each run pins one registry snapshot; dynamic registration affects future runs.
        const toolSnapshot = this.toolRegistry.snapshot();
        const merged: ToolConfig[] = toolSnapshot.tools;
        // 项目 wiki 内置工具（wiki.read 只读免审批；wiki.update 归写能力，走既有判权）。
        if (this.wiki.enabled) {
            merged.push(...wikiToolConfigs(this.wiki));
        }
        const gateway = new RuntimeToolGateway({
            rootGoalId,
            goalId,
            taskId: goalId,
            level,
            tools: merged,
            execute: (tool, args, ctx) => this.executeEffectful(tool, args, ctx),
            ...(this.workspaceRoot !== undefined ? { workspaceRoot: this.workspaceRoot } : {}),
            audit: new RuntimePolicyAuditSink({ emit: (event) => this.bus.emit(event) }),
            ...(this.approvalSeam ? { approval: this.approvalSeam } : {}),
            approvalStore: this.approvalStore,
            ...(sessionId !== undefined ? { sessionId } : {}),
            commandPolicy: this.commandPolicy,
        });
        const visible = new Set(gateway.visibleToolNames());
        const configured = this.config.goal?.allowedTools;
        const visibleNames = configured === undefined ? merged.map((t) => t.name) : configured;
        // 运行级白名单只收窄：与配置白名单取交集（显式空数组 = 本次不暴露任何工具）。
        const names = (
            allowedToolsOverride === undefined
                ? visibleNames
                : visibleNames.filter((name) => allowedToolsOverride.includes(name))
        ).filter((name) => visible.has(name));
        const tools: ToolSchema[] = merged
            .filter((t) => names.includes(t.name))
            .map((t) => ({
                name: t.name,
                description: t.description,
                parameters: (t.parameters ?? undefined) as ToolSchema['parameters'],
            }));
        const invoke: GoalToolInvoker['invoke'] = async (toolName, args, ctx) => {
            const result = await gateway.invoke(toolName, args, ctx ?? {});
            return result.ok
                ? { ok: true, content: String(result.content ?? '') }
                : { ok: false, content: '', error: result.error ?? 'tool failed' };
        };
        return {
            tools,
            invoker: { invoke },
            allowedTools: names,
            planTools: merged.map((tool) => ({
                name: tool.name,
                minPermission: permissionForTool(tool),
            })),
            toolsetVersion: toolSnapshot.version,
            toolsetDigest: toolSnapshot.digest,
        };
    }

    /**
     * 基础系统提示 + 已挂载 Skill 的 L1 目录（渐进披露第 1 层：name/description/path）。
     * 正文（L2）与随包文件（L3）由模型用已有工具按需读取，不预先注入。
     */
    private systemPromptWithSkills(
        rootGoalId: string,
        goalId: string,
        skillIds?: readonly string[],
        promptFragment?: string,
    ): string {
        const base = this.config.systemPrompt ?? DEFAULT_AGENT_SYSTEM_PROMPT;
        const context = { rootGoalId, goalId };
        const entries =
            skillIds === undefined
                ? (this.skillProvider?.catalog(context) ?? [])
                : (this.skillProvider?.catalogFor?.(skillIds, context) ??
                  (this.skillProvider?.catalog(context) ?? []).filter((entry) =>
                      skillIds.includes(entry.id),
                  ));
        const parts = [base];
        if (entries.length > 0) {
            const catalog = entries
                .map((entry) => `- ${entry.name}：${entry.description}（${entry.path}）`)
                .join('\n');
            parts.push(
                '## 可用技能（Skill）\n' +
                    catalog +
                    '\n\n当请求与某个技能描述相关时，先用 fs.read 读取该技能的 SKILL.md 并按其中步骤执行；' +
                    '正文提到的随包文件按相对路径继续读取。',
            );
        }
        // Feature 开关的提示片段：追加在最后（只增文本，不改工具面与权限）。
        if (promptFragment !== undefined && promptFragment.trim().length > 0) {
            parts.push(promptFragment.trim());
        }
        return parts.join('\n\n');
    }

    /** 运行边界开关审计：本次运行带了哪些 Feature、值从哪来（flag.evaluated）。 */
    private emitFlagEvent(
        rootGoalId: string,
        goalId: string,
        values: Record<string, boolean>,
        trace: Array<{ id: string; enabled: boolean; source: string }>,
    ): void {
        const enabledIds = Object.entries(values)
            .filter(([, enabled]) => enabled)
            .map(([id]) => id)
            .sort();
        this.bus.emit(
            newHarnessEvent({
                type: 'flag.evaluated',
                rootGoalId,
                goalId,
                attributes: {
                    'harness.flag_overrides': { ...values },
                    'harness.feature_ids': enabledIds,
                },
                payload: { values: { ...values }, trace: trace.map((step) => ({ ...step })) },
            }),
        );
    }

    /** Skill 运行边界事件：携 harness.skill_id（可回放"本次运行带上了哪些技能"）。 */
    private emitSkillEvent(
        type: 'capability.activated' | 'capability.deactivated',
        skillId: string,
        rootGoalId: string,
        goalId: string,
    ): void {
        this.bus.emit(
            newHarnessEvent({
                type,
                rootGoalId,
                goalId,
                attributes: { 'harness.skill_id': skillId, 'harness.level': 'info' },
                payload: { skillId },
            }),
        );
    }

    /** 工具配置执行：fs.read / shell.run / CLI command / impl（经网关判权后调用）。 */
    private async executeToolConfig(
        tool: ToolConfig | undefined,
        args: Record<string, unknown>,
    ): Promise<ToolCallResult> {
        const toolName = tool?.name ?? '';
        if (this.workspaceRoot !== undefined && toolName !== 'shell.run' && toolName !== 'git') {
            for (const key of ['path', 'a', 'b']) {
                const value = args[key];
                if (typeof value === 'string' && value.length > 0) {
                    try {
                        assertInsideWorkspace(this.workspaceRoot, value);
                    } catch (error) {
                        return {
                            ok: false,
                            error: error instanceof Error ? error.message : String(error),
                        };
                    }
                }
            }
        }
        if (toolName === 'fs.read') {
            const res = await fsReadToolImpl(args, this.workspaceRoot);
            return res.ok
                ? { ok: true, content: String(res.content ?? '') }
                : { ok: false, error: res.error ?? 'tool failed' };
        }
        if (toolName === 'shell.run') {
            const res = await runShellTool(args, this.workspaceRoot);
            return res.ok
                ? { ok: true, content: res.content ?? '' }
                : { ok: false, error: res.error ?? 'tool failed' };
        }
        if (tool?.command) {
            const res = await runCliTool(tool.command, args, this.workspaceRoot);
            return res.ok
                ? { ok: true, content: res.content ?? '' }
                : { ok: false, error: res.error ?? 'tool failed' };
        }
        const impl = tool?.impl;
        if (!impl) {
            return { ok: false, error: `工具未实现：${toolName}` };
        }
        const res = await impl(args);
        return res.ok
            ? { ok: true, content: String(res.content ?? '') }
            : { ok: false, error: res.error ?? 'tool failed' };
    }

    private async executeEffectful(
        tool: ToolConfig,
        args: Record<string, unknown>,
        ctx?: { identifiers?: import('@mazi/core').AuditIdentifiers },
    ): Promise<ToolCallResult> {
        const identifiers = ctx?.identifiers;
        const paths = this.workspaceRoot !== undefined ? effectPathsForTool(tool, args) : [];
        const before =
            paths.length > 0 && this.workspaceRoot !== undefined
                ? snapshotFiles(this.workspaceRoot, paths)
                : [];
        const result = await this.executeToolConfig(tool, args);
        if (before.length > 0 && identifiers !== undefined) {
            await this.effectStore.append(
                newEffectRecord({
                    rootGoalId: identifiers.rootGoalId,
                    goalId: identifiers.goalId,
                    taskId: identifiers.taskId,
                    stepId: identifiers.stepId,
                    toolName: tool.name,
                    args,
                    before,
                }),
            );
        }
        return result;
    }

    listEffects(rootGoalId: string): Promise<EffectRecord[]> {
        return this.effectStore.list(rootGoalId);
    }

    async rememberMemory(items: readonly MemoryItem[]): Promise<void> {
        await this.memoryManager.remember(items);
    }

    listMemory(query = {}): Promise<readonly MemoryItem[]> {
        return this.memoryManager.recall(query);
    }

    async exportPortableBundle(rootGoalIds: readonly string[]): Promise<MemoryBundle> {
        const auditTrails = rootGoalIds.map((rootGoalId) => {
            const verification = this.bus.verifyChain(rootGoalId);
            if (!verification.ok) {
                throw new Error(
                    `拒绝导出被篡改的审计链 ${rootGoalId}: ${verification.reason ?? 'unknown'}`,
                );
            }
            return {
                rootGoalId,
                head: verification.head ?? '',
                events: this.bus.replay(rootGoalId),
            };
        });
        return exportMemoryBundle(this.memoryManager, Date.now, auditTrails);
    }

    importPortableBundle(bundle: MemoryBundle): Promise<{ imported: number }> {
        return importMemoryBundle(this.memoryManager, bundle);
    }

    /** Dynamic registration is pinned at the next run boundary. */
    registerTool(tool: ToolConfig): number {
        return this.toolRegistry.register(tool);
    }

    unregisterTool(name: string): boolean {
        return this.toolRegistry.unregister(name);
    }

    /** Restore reversible file effects in reverse execution order. */
    async rollbackGoal(rootGoalId: string): Promise<EffectRecord[]> {
        if (this.workspaceRoot === undefined) {
            throw new Error('回滚需要工作区根路径');
        }
        const effects = await rollbackEffects(this.effectStore, rootGoalId, this.workspaceRoot);
        for (const effect of effects) {
            this.bus.emit(
                newHarnessEvent({
                    type: 'rollback.executed',
                    rootGoalId,
                    goalId: effect.goalId,
                    taskId: effect.taskId,
                    stepId: effect.stepId,
                    attributes: {
                        'harness.level': effect.status === 'rolled-back' ? 'info' : 'error',
                    },
                    payload: {
                        effectId: effect.effectId,
                        status: effect.status,
                        paths: effect.before.map((item) => item.path),
                        ...(effect.error !== undefined ? { error: effect.error } : {}),
                    },
                }),
            );
        }
        await this.bus.flush();
        return effects;
    }
}
/**
 * 合并 system prompt 片段：Feature 片段在前，项目 wiki 快照在后（只增文本，不改工具面）。
 */
function combinePromptFragments(
    featureFragment: string | undefined,
    wikiFragment: string | undefined,
): string | undefined {
    const parts = [featureFragment?.trim() ?? '', wikiFragment?.trim() ?? ''].filter(
        (part) => part.length > 0,
    );
    return parts.length > 0 ? parts.join('\n\n') : undefined;
}

function assertInsideWorkspace(workspaceRoot: string, path: string): void {
    const root = resolve(workspaceRoot);
    const target = resolve(isAbsolute(path) ? path : resolve(root, path));
    const rel = relative(root, target);
    if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(`路径越出工作区：${path}`);
    }
}

/**
 * 项目 wiki 的内置工具面（设计 §9）：
 * - wiki.read：读快照/变更日志（只读，免审批）；
 * - wiki.update：替换快照 / 追加条目（写能力，走既有判权与审批）。
 */
function wikiToolConfigs(wiki: WikiService): ToolConfig[] {
    return [
        {
            name: 'wiki.read',
            description:
                'Read the project wiki (state snapshot + change log). Prefer this over re-scanning the repository when you need the latest project status.',
            parameters: {
                type: 'object',
                properties: {
                    section: {
                        type: 'string',
                        enum: ['snapshot', 'log', 'all'],
                        description:
                            'snapshot = project state (default); log = change entries; all = both',
                    },
                    limit: {
                        type: 'number',
                        description: 'Max change-log entries to return (default: all)',
                    },
                },
            },
            minPermission: 'read-only',
            sideEffects: [],
            impl: async (args) => {
                const section = args.section;
                const result = wiki.readForTool({
                    ...(section === 'snapshot' || section === 'log' || section === 'all'
                        ? { section }
                        : {}),
                    ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
                });
                return result.ok
                    ? { ok: true, content: result.content ?? '' }
                    : { ok: false, error: result.error ?? 'wiki.read failed' };
            },
        },
        {
            name: 'wiki.update',
            description:
                'Update the project wiki: replace the state snapshot and/or append functional-level change entries (one short line each, no file names). Use at the end of a session that changed the project.',
            parameters: {
                type: 'object',
                properties: {
                    snapshot: {
                        type: 'string',
                        description:
                            'Full markdown snapshot; must contain at least one "## " section (概览/结构与模块/模块职责/进行中的工作/约定与注意)',
                    },
                    entries: {
                        type: 'array',
                        items: { type: 'string' },
                        description:
                            'Functional-level change descriptions, e.g. "新增项目 wiki 的读取与上下文注入"',
                    },
                },
            },
            minPermission: 'draft',
            sideEffects: ['fs'],
            impl: async (args) => {
                const result = await wiki.updateForTool({
                    ...(typeof args.snapshot === 'string' ? { snapshot: args.snapshot } : {}),
                    ...(typeof args.entries === 'string'
                        ? { entries: args.entries }
                        : Array.isArray(args.entries)
                          ? {
                                entries: args.entries.filter(
                                    (item): item is string => typeof item === 'string',
                                ),
                            }
                          : {}),
                });
                return result.ok
                    ? { ok: true, content: result.content ?? '' }
                    : { ok: false, error: result.error ?? 'wiki.update failed' };
            },
        },
    ];
}
