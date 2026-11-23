import type { EventBus, Goal, NegotiationAnswer, PermissionLevel, Step, Task } from '@mazi/core';
import { authz } from '@mazi/core';
import type { GoalTreeSnapshot, UserBehaviorView, UserQuestionView } from '@mazi/libs';
import {
    type AgentRole,
    type DelegationEdge,
    type DelegationProposal,
    resolveRoleSkillIds,
    SuperAgent,
    type SuperAgentDecision,
    type SuperAgentInput,
} from '../agent/index.js';
import { DelegationStack } from '../agent/stack.js';
import type { IterationTracker } from '../analysis/iteration-tracker.js';
import { AnalysisStack } from '../analysis/stack.js';
import type { TocAnalyst } from '../analysis/toc-analyst.js';
import { loadCommandPolicy } from '../auth/command-policy.js';
import {
    MemoryBlackboardStore,
    type ProjectBlackboard,
    ProjectBlackboardService,
    SqliteBlackboardStore,
} from '../blackboard/index.js';
import type { SkillProvider } from '../capabilities/runtime.js';
import type { RuntimeConfig, ToolCallResult, ToolConfig } from '../config.js';
import {
    type EffectRecord,
    effectPathsForTool,
    MemoryEffectStore,
    newEffectRecord,
    SqliteEffectStore,
    snapshotFiles,
} from '../effects/effect-store.js';
import { emitFault } from '../events/emitters.js';
import { ConsoleSink, DefaultEventBus, newHarnessEvent } from '../events/index.js';
import { StepEventEmitter } from '../events/step-events.js';
import { DefaultFaultPipeline } from '../faults/index.js';
import { applyNegotiationAnswers } from '../gts/negotiation.js';
import {
    compileTaskPlan,
    effectiveGoalLimits,
    type PlannedTask,
    type PlanTool,
} from '../gts/plan-graph.js';
import type { ReplanPlanner } from '../gts/replan.js';
import {
    allocateTaskBudgets,
    createLlmTaskPlanner,
    DEFAULT_MAX_PLAN_TASKS,
    type TaskPlanner,
    type TaskPlannerHistoryEntry,
} from '../gts/task-planner.js';
import { HookRunner, SessionLifecycle } from '../hooks/index.js';
import { RuntimeKernel } from '../kernel/index.js';
import { RuntimePorts } from '../kernel/ports.js';
import {
    type BehaviorMigrationResult,
    MemoryBehaviorStore,
    SqliteBehaviorStore,
} from '../memory/behavior-store.js';
import {
    type FailureLedgerEntry,
    type FailureLedgerQuery,
    SqliteFailureLedger,
} from '../memory/failure-ledger.js';
import { type GoalStore, SqliteGoalStore } from '../memory/goal-store.js';
import { MemoryManager } from '../memory/memory.js';
import { PersonalMemoryService } from '../memory/personal-memory.js';
import type { QuestionLabelInput, QuestionQuery } from '../memory/question-store.js';
import { type MemoryItem, SqliteMemoryStore } from '../memory/store.js';
import { exportMemoryBundle, importMemoryBundle, type MemoryBundle } from '../memory/transfer.js';
import { BehaviorRecorder } from '../observability/behavior-recorder.js';
import { maziHome, maziPaths } from '../paths.js';
import { memoryPlugin, PluginHost } from '../plugins/index.js';
import {
    type AgentPromptId,
    MemoryPromptPackStore,
    type PromptPack,
    PromptPackRegistry,
    type PromptTaskKind,
    resolveAgentPrompt,
    resolveBaseAgentPrompt,
    SqlitePromptPackStore,
} from '../prompts/index.js';
import { modelIdOf, offeringIdOf, providerIdOf } from '../provider/catalog/contract.js';
import type { CatalogService } from '../provider/catalog/service.js';
import { RoundExecutor } from '../provider/index.js';
import type { QuestionClassifier } from '../question/labeler.js';
import { QuestionService } from '../question/service.js';
import type { QuestionTaxonomy } from '../question/taxonomy.js';
import type { GoalRunResult } from '../strategy/goal-strategy.js';
import { configureTokenizer } from '../token-estimator.js';
import { BUILTIN_TOOL_PRESET } from '../tool-gateway/builtin.js';
import { RuntimeToolRegistry } from '../tool-gateway/registry.js';
import { createConditionEnvironment } from '../verifier/environment.js';
import { IndependentVerifier, type SemanticJudge } from '../verifier/index.js';
import { ProjectWikiService, WikiService } from '../wiki/index.js';
import type { FeedbackInput, RunOptions } from './conversation.js';
import { buildLlmProviders, ModelResolver } from './model-resolver.js';
import { rollbackGoalEffects } from './rollback.js';
import { type ModelRecoveryFn, RoundRunner } from './round-runner.js';
import { createRuntimeContext, type RuntimeContext } from './runtime-context.js';
import { sessionContextFragment } from './session-context.js';
import { SessionFactory } from './session-factory.js';
import { SessionIntake } from './session-intake.js';
import { assertInsideWorkspace } from './tool-configs.js';
import { fsReadToolImpl, runCliTool, runShellTool } from './tool-executor.js';
import { ToolPlane } from './tool-plane.js';
import { TRIAGE_TIMEOUT_MS, withTriageTimeout } from './triage-support.js';
import { TurnEngine } from './turn-engine.js';

/** 取值兜底：非有限数 → 0（花费回填的 token 字段）。 */
function numberOf(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** GoalRunResult → goal.ended summary（截断 2000 字符） */
function _goalRunSummary(result: GoalRunResult): string {
    const last = result.tasks[result.tasks.length - 1];
    if (result.rejected && result.rejected.length > 0) {
        return result.rejected.join(';').slice(0, 2000);
    }
    const summary = result.finalAnswer ?? last?.finalMessage ?? last?.errorMessage;
    return summary && summary.length > 0 ? summary.slice(0, 2000) : '';
}

/**
 * HarnessRuntime —— Goal/Task/Step 坐标系运行器（C5 收口后为唯一执行面）。
 * createGoalSession（单 Goal 落库：user intent 直接产 Goal）→ executeGoalTree（plan→逐 Task，事实经 GoalStore 留痕）；
 * 事件全部经 DefaultEventBus 落盘 JSONL（按 rootGoalId=运行会话 id 分文件）。
 * 本类只负责生命周期编排与 collaborator 组装；轮次执行归 RoundRunner，
 * 模型/计价解析归 ModelResolver，Step 事件归 StepEventEmitter，工具执行归 tool-executors。
 */
/** 允许 hook patch 传入的纯记录（拒绝数组 / null）。 */
export class HarnessRuntime {
    /**
     * 按平面分组的运行时对象图（观测/智能/工具/会话/记忆/分析/委派/装配）。
     * 所有协作者与运行期接入点都从这里取，本类不再逐项持有。
     */
    private readonly ctx: RuntimeContext;

    constructor(config: RuntimeConfig, options: RunOptions = {}) {
        this.ctx = createRuntimeContext();
        this.ctx.session.sessionIds = new Map<string, string>();
        this.ctx.session.intake = new SessionIntake();
        this.ctx.session.running = new Map<string, AbortController>();
        this.ctx.assembly.ports = new RuntimePorts();
        this.ctx.assembly.approvalStore = new authz.InMemoryApprovalStore();
        this.ctx.assembly.maxReplans = 2;
        this.ctx.assembly.config = config;
        this.ctx.assembly.commandPolicy = loadCommandPolicy(
            config.authCommandPolicyFile ?? maziPaths().authCommandPolicyFile,
        ).policy;
        this.ctx.tools.registry = new RuntimeToolRegistry([
            ...BUILTIN_TOOL_PRESET,
            ...config.tools,
        ]);
        this.ctx.assembly.promptPacks = new PromptPackRegistry(
            undefined,
            config.dbPath !== undefined
                ? new SqlitePromptPackStore(config.dbPath)
                : new MemoryPromptPackStore(),
        );
        this.ctx.intelligence.superAgent = new SuperAgent(this.ctx.assembly.promptPacks);
        this.ctx.intelligence.verifier = new IndependentVerifier({
            // Lazy workspace lookup: the root is assigned a few lines below.
            environment: createConditionEnvironment(() => this.ctx.assembly.workspaceRoot),
        });
        this.ctx.delegation = new DelegationStack(config);
        configureTokenizer(config.tokenizerEncoding);
        this.ctx.assembly.workspaceRoot = options.workspaceRoot;
        this.ctx.assembly.taskPlanner = options.taskPlanner;
        this.ctx.assembly.taskPlanningByDefault =
            options.taskPlanning === true || options.taskPlanner !== undefined;
        this.ctx.observability.bus = new DefaultEventBus({
            eventDir: config.eventDir,
            sessionOf: (rootGoalId) => this.ctx.session.sessionIds.get(rootGoalId),
        });
        this.ctx.observability.hookRunner = new HookRunner({
            emit: (event) => this.ctx.observability.bus.emit(event),
        });
        this.ctx.observability.lifecycle = new SessionLifecycle({
            bus: this.ctx.observability.bus,
            hooks: this.ctx.observability.hookRunner,
            sessionIds: this.ctx.session.sessionIds,
        });
        this.ctx.observability.faultPipeline = new DefaultFaultPipeline({
            emit: (type, fault, recovery) =>
                emitFault(this.ctx.observability.bus, type, fault, recovery),
        });
        // 问题/行为统一入 SQLite 权威库；JSONL 目录降级为导出/迁移来源。
        const behaviorStore =
            config.dbPath !== undefined
                ? new SqliteBehaviorStore(config.dbPath)
                : new MemoryBehaviorStore();
        this.ctx.memory.behaviorRecorder = new BehaviorRecorder(behaviorStore);
        this.ctx.memory.questionService = new QuestionService({
            ...(config.dbPath !== undefined ? { dbPath: config.dbPath } : {}),
            taxonomyFile: config.questionTaxonomyFile ?? maziPaths().questionTaxonomyFile,
        });
        if (config.behaviorDir !== undefined && config.dbPath !== undefined) {
            void this.migrateBehaviorStream().catch((error: unknown) => {
                process.stderr.write(`behavior migration error: ${String(error)}\n`);
            });
        }
        this.ctx.memory.failureLedger = new SqliteFailureLedger(config.dbPath ?? ':memory:');
        this.ctx.observability.bus.subscribe(
            { types: ['approval.requested', 'approval.granted', 'approval.cancelled'] },
            {
                id: 'behavior-recorder',
                handle: (event) => {
                    void this.ctx.memory.behaviorRecorder
                        .handleApprovalEvent(event)
                        .catch((error: unknown) => {
                            process.stderr.write(`behavior capture error: ${String(error)}\n`);
                        });
                },
            },
        );
        this.ctx.memory.goalStore = new SqliteGoalStore(config.dbPath ?? ':memory:');
        this.ctx.memory.memoryManager = new MemoryManager(
            config.dbPath !== undefined ? { store: new SqliteMemoryStore(config.dbPath) } : {},
        );
        this.ctx.memory.personalMemory = new PersonalMemoryService(this.ctx.memory.memoryManager);
        this.ctx.memory.effectStore =
            config.dbPath !== undefined
                ? new SqliteEffectStore(config.dbPath)
                : new MemoryEffectStore();
        this.ctx.memory.blackboard = new ProjectBlackboardService(
            config.dbPath !== undefined
                ? new SqliteBlackboardStore(config.dbPath)
                : new MemoryBlackboardStore(),
        );
        this.ctx.intelligence.resolver = new ModelResolver(
            config,
            buildLlmProviders(config, options),
        );
        this.ctx.observability.stepEvents = new StepEventEmitter(this.ctx.observability.bus);
        this.ctx.memory.wiki = new WikiService({
            home: maziHome(),
            ...(options.workspaceRoot !== undefined ? { workspace: options.workspaceRoot } : {}),
            ...(config.wiki ?? {}),
        });
        this.ctx.memory.projectWiki =
            options.workspaceRoot !== undefined
                ? new ProjectWikiService({ workspace: options.workspaceRoot })
                : undefined;
        this.ctx.intelligence.roundRunner = new RoundRunner({
            bus: this.ctx.observability.bus,
            executor: new RoundExecutor(),
            resolver: this.ctx.intelligence.resolver,
        });
        this.ctx.analysis = new AnalysisStack({
            ...(config.dbPath !== undefined ? { dbPath: config.dbPath } : {}),
            snapshotOf: (rootGoalId) => this.goalSnapshot(rootGoalId),
            requestRound: (rootGoalId, ctx, reasoningLevel) =>
                this.ctx.intelligence.roundRunner.requestRound(rootGoalId, ctx, reasoningLevel),
            resolveModelChoice: (modelId) =>
                this.ctx.intelligence.resolver.resolveModelChoice(modelId),
            systemPrompt: this.agentPrompt('iteration-analysis'),
        });
        if (config.consoleEnabled ?? false) {
            this.ctx.observability.bus.subscribe({}, new ConsoleSink());
        }
        this.ctx.session.factory = new SessionFactory({
            intake: this.ctx.session.intake,
            sessionIds: this.ctx.session.sessionIds,
            beginSession: (sessionId) => this.beginSession(sessionId),
            ...(this.ctx.assembly.workspaceRoot !== undefined
                ? { workspaceRoot: this.ctx.assembly.workspaceRoot }
                : {}),
            config: this.ctx.assembly.config,
            blackboard: this.ctx.memory.blackboard,
            memoryManager: this.ctx.memory.memoryManager,
            goalStoreDb: this.ctx.memory.goalStore,
            behaviorRecorder: this.ctx.memory.behaviorRecorder,
            labelQuestion: (questionId, text) =>
                this.ctx.memory.questionService.label(questionId, text),
            bus: this.ctx.observability.bus,
            resolver: this.ctx.intelligence.resolver,
            roundRunner: this.ctx.intelligence.roundRunner,
            intentPrompt: () => this.agentPrompt('intent'),
        });
        this.ctx.tools.plane = new ToolPlane({
            config: this.ctx.assembly.config,
            toolRegistry: this.ctx.tools.registry,
            ...(this.ctx.assembly.workspaceRoot !== undefined
                ? { workspaceRoot: this.ctx.assembly.workspaceRoot }
                : {}),
            hooks: this.ctx.observability.hookRunner,
            faults: this.ctx.observability.faultPipeline,
            bus: this.ctx.observability.bus,
            approvalStore: this.ctx.assembly.approvalStore,
            commandPolicy: this.ctx.assembly.commandPolicy,
            ...(this.ctx.memory.projectWiki !== undefined
                ? { projectWiki: this.ctx.memory.projectWiki }
                : {}),
            wiki: this.ctx.memory.wiki,
            blackboard: this.ctx.memory.blackboard,
            delegationRoles: this.ctx.delegation.roles,
            getSkillProvider: () => this.ctx.assembly.skillProvider,
            getApprovalSeam: () => this.ctx.assembly.approvalSeam,
            execute: (tool, args, ctx, roots) => this.executeEffectful(tool, args, ctx, roots),
            delegate: (input) =>
                this.delegateAgents(
                    input.rootGoalId,
                    input.parentGoal,
                    input.args,
                    input.projectId,
                    input.userId,
                    input.delegationDepth,
                ),
        });
        const self = this;
        this.ctx.session.turns = new TurnEngine({
            bus: this.ctx.observability.bus,
            config: this.ctx.assembly.config,
            intake: this.ctx.session.intake,
            goalStoreDb: this.ctx.memory.goalStore,
            memoryManager: this.ctx.memory.memoryManager,
            failureLedger: this.ctx.memory.failureLedger,
            lifecycle: this.ctx.observability.lifecycle,
            stepEvents: this.ctx.observability.stepEvents,
            superAgent: this.ctx.intelligence.superAgent,
            verifier: this.ctx.intelligence.verifier,
            resolver: this.ctx.intelligence.resolver,
            roundRunner: this.ctx.intelligence.roundRunner,
            wiki: this.ctx.memory.wiki,
            blackboard: this.ctx.memory.blackboard,
            sessions: this.ctx.session.factory,
            toolPlane: this.ctx.tools.plane,
            get workspaceRoot() {
                return self.ctx.assembly.workspaceRoot;
            },
            get projectWiki() {
                return self.ctx.memory.projectWiki;
            },
            get skillProvider() {
                return self.ctx.assembly.skillProvider;
            },
            get replanPlanner() {
                return self.ctx.assembly.replanPlanner;
            },
            get maxReplans() {
                return self.ctx.assembly.maxReplans;
            },
            get taskPlanningByDefault() {
                return self.ctx.assembly.taskPlanningByDefault;
            },
            get running() {
                return self.ctx.session.running;
            },
            completeDirectGoal: (goal, answer) => self.completeDirectGoal(goal, answer),
            generateTaskPlan: (rootGoalId, goal, model, reasoningLevel, history, tools, fragment) =>
                self.generateTaskPlan(
                    rootGoalId,
                    goal,
                    model,
                    reasoningLevel,
                    history,
                    tools,
                    fragment,
                ),
            systemPromptWithSkills: (rootGoalId, goalId, skillIds, promptFragment) =>
                self.systemPromptWithSkills(rootGoalId, goalId, skillIds, promptFragment),
            codingPromptFragment: (kind) => self.codingPromptFragment(kind),
            projectWikiPromptFragment: () => self.projectWikiPromptFragment(),
            ensureProjectWikiInitialized: () => self.ensureProjectWikiInitialized(),
        });
        this.ctx.assembly.kernel = new RuntimeKernel();
        this.ctx.assembly.kernel.provide({
            name: 'eventBus',
            create: () => this.ctx.observability.bus,
        });
        this.ctx.assembly.kernel.provide({
            name: 'faults',
            requires: ['eventBus'],
            create: () => this.ctx.observability.faultPipeline,
        });
        this.ctx.assembly.kernel.provide({
            name: 'hooks',
            requires: ['eventBus'],
            create: () => this.ctx.observability.hookRunner,
        });
        this.ctx.assembly.kernel.provide({
            name: 'tools',
            requires: ['eventBus'],
            create: () => this.ctx.tools.registry,
        });
        this.ctx.assembly.plugins = new PluginHost({
            kernel: this.ctx.assembly.kernel,
            hooks: this.ctx.observability.hookRunner,
            ports: this.ctx.assembly.ports,
            eventBus: this.ctx.observability.bus,
        });
        void this.ctx.assembly.plugins
            .install(memoryPlugin(this.ctx.memory.personalMemory))
            .catch((error) => {
                this.warn(`memory 插件安装失败：${error instanceof Error ? error.message : error}`);
            });
        this.ctx.assembly.kernel.provide({
            name: 'memoryManager',
            requires: ['memory'],
            create: () => this.ctx.memory.memoryManager,
        });
        this.ctx.assembly.kernel.provide({
            name: 'goalStore',
            create: () => this.ctx.memory.goalStore,
        });
        this.ctx.assembly.kernel.provide({
            name: 'behavior',
            requires: ['eventBus'],
            create: () => this.ctx.memory.behaviorRecorder,
        });
        this.ctx.assembly.kernel.provide({
            name: 'wiki',
            requires: ['eventBus'],
            create: () => this.ctx.memory.wiki,
        });
        this.ctx.assembly.kernel.provide({
            name: 'verifier',
            create: () => this.ctx.intelligence.verifier,
        });
        this.ctx.assembly.kernel.provide({
            name: 'planner',
            create: () => this.ctx.session.factory,
        });
        this.ctx.assembly.kernel.provide({
            name: 'toolPlane',
            requires: ['eventBus', 'hooks', 'faults'],
            create: () => this.ctx.tools.plane,
        });
        this.ctx.assembly.kernel.provide({ name: 'ports', create: () => this.ctx.assembly.ports });
        this.ctx.assembly.kernel.start();
    }

    get eventBus(): EventBus {
        return this.ctx.observability.bus;
    }

    /** 钩子宿主（插件/宿主可注册；注册返回撤销函数）。 */
    get hooks(): HookRunner {
        return this.ctx.observability.hookRunner;
    }

    /** 能力接入点（插件/宿主登记与读取；运行期 setter 的唯一落点）。 */
    get ports(): RuntimePorts {
        return this.ctx.assembly.ports;
    }

    /** 装配容器（服务注册 / 依赖顺序 / 生命周期释放）。 */
    get kernel(): RuntimeKernel {
        return this.ctx.assembly.kernel;
    }

    /**
     * 会话开始：进程内幂等。session.started 以会话锚点落盘（session-<id>.jsonl），
     * 因此会话级事件不依赖当时是否已有 rootGoal。
     */
    async beginSession(sessionId: string): Promise<void> {
        await this.ctx.observability.lifecycle.begin(sessionId);
    }

    async endSession(sessionId: string, reason = 'session-ended'): Promise<void> {
        await this.ctx.observability.lifecycle.end(sessionId, reason);
    }

    /** 接入目录与账本：此后每轮 LLM 调用按钉死的 offering 价目追加 UsageRecord。 */
    setCatalog(service: CatalogService): void {
                this.ctx.assembly.catalogService = service;
        this.ctx.assembly.ports.set('catalog', service);
        this.ctx.intelligence.roundRunner.setCatalog(service);
    }

    /** 接入已挂载技能包：工具并入每次 Goal 的执行工具面，档位按包 ceiling 收敛。 */
    setSkillProvider(provider?: SkillProvider): void {
                this.ctx.assembly.skillProvider = provider;
        this.ctx.assembly.ports.set('skillProvider', provider);
    }

    /**
     * 回填历史花费凭证：把已落库 Step 的 vendor 原始用量（`usage.raw`）按当前目录价目结算进账本。
     * 凭证 id = `bf:<stepId>`，重复调用幂等；目录未收录/无价的模型跳过（目录是权威）。
     */
    async backfillUsage(): Promise<{ recorded: number; skipped: number }> {
        const service = this.ctx.assembly.catalogService;
        if (service === undefined) return { recorded: 0, skipped: 0 };
        const existing = new Set((await service.usageRecords()).map((record) => record.id));
        const steps = await this.ctx.memory.goalStore.listAllSteps();
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
        this.ctx.assembly.ports.set('modelRecovery', fn);
        this.ctx.intelligence.roundRunner.setRecovery(fn);
    }

    /** 接入人审审批 seam；缺省时运行时网关回退到 ceiling 常设授权。 */
    setApprovalSeam(seam: authz.ApprovalSeam): void {
                this.ctx.assembly.approvalSeam = seam;
        this.ctx.assembly.ports.set('approvalSeam', seam);
    }

    /** 问题标签分类法（注册表；GET /api/question-taxonomy 消费）。 */
    getQuestionTaxonomy(): QuestionTaxonomy {
        return this.ctx.memory.questionService.taxonomyView();
    }

    /** 对某问题重跑 LLM 精标（需已注入分类器）；返回是否命中该问题。 */
    async classifyQuestion(questionId: string): Promise<boolean> {
        return this.ctx.memory.questionService.classify(questionId);
    }

    /** 注入 LLM 问题分类器（可选；不注入则仅规则预标注）。输出经注册表校验后落库。 */
    setQuestionClassifier(classifier: QuestionClassifier): void {
        this.ctx.memory.questionService.setClassifier(classifier);
    }

    /** Goal/Task/Step 存储（Goal 会话审计/级联删除） */
    get goalStore(): GoalStore {
        return this.ctx.memory.goalStore;
    }

    /** TOC 冻结、独立分析、反馈与 Iterations 聚合（独立于 Goal 坐标系） */
    get tocAnalyst(): TocAnalyst {
        return this.ctx.analysis.toc;
    }

    /** 系统迭代记录（分析报告 → 系统改动闭环；版本快照由 API 层注入）。 */
    get iterationTracker(): IterationTracker {
        return this.ctx.analysis.iterations;
    }

    get currentWorkspaceRoot(): string | undefined {
        return this.ctx.assembly.workspaceRoot;
    }

    async close(): Promise<void> {
        await this.ctx.assembly.plugins.uninstallAll();
        this.ctx.assembly.kernel.dispose();
        this.ctx.memory.goalStore.close();
        this.ctx.memory.memoryManager.close();
        this.ctx.memory.effectStore.close();
        this.ctx.memory.blackboard.close();
        this.ctx.assembly.promptPacks.close();
        this.ctx.delegation.close();
        this.ctx.analysis.close();
        this.ctx.memory.behaviorRecorder.close();
        this.ctx.memory.questionService.close();
        this.ctx.memory.failureLedger.close();
    }

    /** 创建 Goal 会话：委托 SessionFactory（创建立即返回，triage 异步增强）。 */
    async createGoalSession(
        input: string,
        opts: RunOptions = {},
    ): Promise<{ rootGoalId: string; goalId: string }> {
        return this.ctx.session.factory.create(input, opts);
    }

    /**
     * 协商答复 → 修订并重新冻结契约（goal.contract-revised 是唯一合法迁移记录）。
     * 只在 goal 处于 blocked 且未经答复时受理；重复调用按幂等处理。
     */
    async negotiateGoal(
        rootGoalId: string,
        answers: readonly NegotiationAnswer[],
    ): Promise<{ goalId: string; revision: number; resolved: boolean }> {
        const goal = await this.ctx.memory.goalStore.loadGoal(rootGoalId);
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
        await this.ctx.memory.goalStore.saveGoal(goal);
        this.ctx.observability.bus.emit(
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
        await this.ctx.observability.bus.flush();
        return {
            goalId: goal.goalId,
            revision: applied.negotiation.revision,
            resolved: applied.negotiation.resolved,
        };
    }

    /** 执行 Goal（plan → 逐 Task；事实全部经 goalStore 留痕）；发 goal.ended / run.aborted */
    /**
     * 执行 Goal 树（带轮次生命周期）：turn.started 在读取 Goal 之后发，
     * turn.ended 无论成功/失败都发（失败信息进 payload）；钩子失败不影响执行。
     */
    async executeGoalTree(
        rootGoalId: string,
        options: { resume?: boolean } = {},
    ): Promise<GoalRunResult> {
        return this.ctx.session.turns.run(rootGoalId, options);
    }

    private async completeDirectGoal(goal: Goal, answer: string): Promise<void> {
        const latest = (await this.ctx.memory.goalStore.loadGoal(goal.goalId)) ?? goal;
        latest.status = 'succeeded';
        latest.endedAt = Date.now();
        await this.ctx.memory.goalStore.saveGoal(latest);
        this.ctx.observability.bus.emit(
            newHarnessEvent({
                type: 'goal.ended',
                rootGoalId: goal.goalId,
                payload: {
                    outcome: { status: 'success', summary: answer.slice(0, 2000) },
                },
            }),
        );
        await this.ctx.observability.bus.flush();
    }

    /** 请求停止运行中的 Goal 树；返回是否命中在跑的运行（不改变已落库事实）。 */
    stopGoalTree(rootGoalId: string): boolean {
        const controller = this.ctx.session.running.get(rootGoalId);
        if (controller === undefined) return false;
        controller.abort();
        return true;
    }

    /** 该 Goal 树当前是否在本实例执行中。 */
    isGoalRunning(rootGoalId: string): boolean {
        return this.ctx.session.running.has(rootGoalId);
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
            promptPackIds?: readonly string[];
        } = {},
    ): Promise<GoalRunResult> {
        if (options.reasoningLevel !== undefined) {
            this.ctx.session.intake.pendingReasoning.set(rootGoalId, options.reasoningLevel);
        }
        if (options.modelId !== undefined) {
            this.ctx.session.intake.pendingModel.set(rootGoalId, options.modelId);
        }
        // 恢复同样携带运行级覆盖（Feature / 技能 / 工具），保证中断前后条件一致。
        if (options.promptFragment !== undefined && options.promptFragment.length > 0) {
            this.ctx.session.intake.pendingPromptFragment.set(rootGoalId, options.promptFragment);
        }
        if (options.skillIds !== undefined) {
            this.ctx.session.intake.pendingSkills.set(rootGoalId, options.skillIds);
        }
        if (options.allowedTools !== undefined) {
            this.ctx.session.intake.pendingAllowedTools.set(rootGoalId, options.allowedTools);
        }
        if (options.flagOverrides !== undefined) {
            this.ctx.session.intake.pendingFlags.set(rootGoalId, {
                values: { ...options.flagOverrides },
                trace: (options.flagTrace ?? []).map((step) => ({ ...step })),
            });
        }
        if (options.promptPackIds !== undefined) {
            this.ctx.session.intake.pendingPromptPackIds.set(rootGoalId, options.promptPackIds);
        }
        this.ctx.observability.bus.emit(
            newHarnessEvent({ type: 'run.resumed', rootGoalId, payload: {} }),
        );
        await this.ctx.observability.bus.flush();
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
        const goals = await this.ctx.memory.goalStore.listGoalsByRoot(rootGoalId);
        const tasks: Task[] = [];
        const steps: Step[] = [];
        for (const goal of goals) {
            const goalTasks = await this.ctx.memory.goalStore.listTasks(goal.goalId);
            tasks.push(...goalTasks);
            for (const task of goalTasks) {
                steps.push(...(await this.ctx.memory.goalStore.listSteps(task.taskId)));
            }
        }
        const { snapshotGoalTree } = await import('../observability/goal-snapshot.js');
        const snapshot = snapshotGoalTree(rootGoalId, goals, tasks, steps);
        const behaviors = await this.ctx.memory.behaviorRecorder.list(rootGoalId);
        return behaviors.length > 0 ? { ...snapshot, behaviors } : snapshot;
    }

    /** 用户对 root goal 结果的反馈（CLI/调用方显式给出）：先落行为流，再发事件。 */
    async recordFeedback(rootGoalId: string, feedback: FeedbackInput): Promise<void> {
        await this.ctx.memory.behaviorRecorder.recordFeedback(rootGoalId, feedback);
        this.ctx.observability.bus.emit(
            newHarnessEvent({
                type: 'user.feedback.captured',
                rootGoalId,
                attributes: { 'user.feedback_type': feedback.type },
                payload: { feedback },
            }),
        );
        return this.ctx.observability.bus.flush();
    }

    /** 读取会话的用户行为指令（Step 投影输入；见 @mazi/libs projectBehaviorTimeline）。 */
    listBehaviors(rootGoalId: string): Promise<UserBehaviorView[]> {
        return this.ctx.memory.behaviorRecorder.list(rootGoalId);
    }

    /** 问题视图（含有效标签）——apps/api 问题查询消费。 */
    async listQuestions(query: QuestionQuery = {}): Promise<UserQuestionView[]> {
        return this.ctx.memory.questionService.list(query);
    }

    /** 单条问题视图（无则 undefined）。 */
    async getQuestion(questionId: string): Promise<UserQuestionView | undefined> {
        return this.ctx.memory.questionService.view(questionId);
    }

    /** 追加标签（append-only；user 覆盖由 effectiveLabels 合并规则承担）。 */
    addQuestionLabels(questionId: string, labels: readonly QuestionLabelInput[]): Promise<void> {
        return this.ctx.memory.questionService.addLabels(questionId, labels);
    }

    /**
     * 一次性把旧 JSONL 行为流导入 SQLite 权威库（幂等；JSONL 原文件保留为证据）。
     * 启动时构造器已 fire-and-forget 调用一次；测试可直接 await。
     */
    migrateBehaviorStream(): Promise<BehaviorMigrationResult> {
        const dir = this.ctx.assembly.config.behaviorDir;
        if (dir === undefined) return Promise.resolve({ partitions: 0, imported: 0 });
        return this.ctx.memory.behaviorRecorder.migrateFromJsonl(dir);
    }

    /** 历史提问回填（采集上线前的 run；写入一条 derived input 并规则标注）。 */
    async backfillBehaviorInput(
        rootGoalId: string,
        run: { input: string; createdAt: number },
    ): Promise<UserBehaviorView[]> {
        const written = await this.ctx.memory.behaviorRecorder.backfillInput(rootGoalId, run);
        const first = written[0];
        if (first !== undefined) {
            await this.ctx.memory.questionService.label(`${rootGoalId}:${first.ts}`, run.input);
        }
        return written;
    }

    /** 清除某运行会话的行为流（治理删除）。 */
    clearBehaviors(rootGoalId: string): Promise<void> {
        return this.ctx.memory.behaviorRecorder.clear(rootGoalId);
    }

    /** 失败分类账查询（apps/api GET /api/ledger 消费）。 */
    listFailures(query: FailureLedgerQuery = {}): Promise<FailureLedgerEntry[]> {
        return this.ctx.memory.failureLedger.list(query);
    }

    /** 级联删除某运行会话的失败记录（Conversation 删除用）。 */
    deleteFailures(rootGoalId: string): Promise<void> {
        return this.ctx.memory.failureLedger.deleteByRoot(rootGoalId);
    }

    /**
     * Goal 执行的工具面：内置 CLI 预设 + config.tools → 经 v2 ToolGateway 判权的
     * ToolSchema/执行器/白名单。supply 视图只暴露当前 permissionCeiling 允许的工具；
     * 白名单缺省 = 全部可见工具；显式空数组 = 纯对话（不注入工具 schema）。
     */
    private async delegateAgents(
        rootGoalId: string,
        parentGoal: Goal,
        args: Record<string, unknown>,
        projectId: string | undefined,
        userId: string | undefined,
        delegationDepth: number,
    ): Promise<ToolCallResult> {
        const raw = Array.isArray(args.delegations) ? args.delegations : [];
        const proposals = raw
            .map((item): DelegationProposal | undefined => {
                if (typeof item !== 'object' || item === null) return undefined;
                const value = item as Record<string, unknown>;
                const statement = typeof value.statement === 'string' ? value.statement.trim() : '';
                const roleId = typeof value.roleId === 'string' ? value.roleId.trim() : '';
                if (!statement || !roleId) return undefined;
                return {
                    statement,
                    roleId,
                    ...(typeof value.ceiling === 'string'
                        ? { ceiling: value.ceiling as PermissionLevel }
                        : {}),
                    ...(typeof value.budget === 'object' && value.budget !== null
                        ? { budget: value.budget as DelegationProposal['budget'] }
                        : {}),
                };
            })
            .filter((item): item is DelegationProposal => item !== undefined);
        if (proposals.length === 0) return { ok: false, error: '缺少有效 delegations' };

        const delegated = await this.ctx.delegation.coordinator.delegate(
            rootGoalId,
            parentGoal,
            proposals,
            async (context) => {
                this.ctx.observability.bus.emit(
                    newHarnessEvent({
                        type: 'delegation.started',
                        rootGoalId,
                        goalId: parentGoal.goalId,
                        attributes: { 'harness.level': 'info' },
                        payload: {
                            roleId: context.role.roleId,
                            statement: context.proposal.statement,
                            permissionCeiling: context.permissionCeiling,
                            budget: context.budget,
                            delegationDepth: delegationDepth + 1,
                        },
                    }),
                );
                const roleSkillIds = resolveRoleSkillIds(
                    this.ctx.assembly.skillProvider?.mounted() ?? [],
                    context.role.skillIds,
                );
                const child = await this.createGoalSession(context.proposal.statement, {
                    ...(projectId !== undefined ? { projectId } : {}),
                    ...(userId !== undefined ? { userId } : {}),
                    permissionCeiling: context.permissionCeiling,
                    ...(context.role.modelId !== undefined
                        ? { modelId: context.role.modelId }
                        : {}),
                    ...(context.role.systemPrompt !== undefined
                        ? { promptFragment: context.role.systemPrompt }
                        : {}),
                    ...(context.role.tools !== undefined
                        ? { allowedTools: context.role.tools }
                        : {}),
                    ...(roleSkillIds !== undefined ? { skillIds: roleSkillIds } : {}),
                    ...(context.budget?.maxSteps !== undefined
                        ? { maxSteps: context.budget.maxSteps }
                        : {}),
                    ...(context.budget?.maxCostUsd !== undefined
                        ? { maxCostUsd: context.budget.maxCostUsd }
                        : {}),
                    delegationDepth: delegationDepth + 1,
                    parseIntent: false,
                });
                const result = await this.executeGoalTree(child.rootGoalId);
                const last = result.tasks.at(-1);
                this.ctx.observability.bus.emit(
                    newHarnessEvent({
                        type: 'delegation.completed',
                        rootGoalId,
                        goalId: parentGoal.goalId,
                        attributes: {
                            'harness.level': result.ok ? 'info' : 'warn',
                        },
                        payload: {
                            roleId: context.role.roleId,
                            childGoalId: child.rootGoalId,
                            ok: result.ok,
                            summary:
                                result.finalAnswer ??
                                last?.finalMessage ??
                                last?.errorMessage ??
                                '',
                        },
                    }),
                );
                return { childGoalId: child.rootGoalId, result };
            },
            parentGoal.goalId,
        );
        if (delegated.violations.length > 0) {
            this.ctx.observability.bus.emit(
                newHarnessEvent({
                    type: 'delegation.rejected',
                    rootGoalId,
                    goalId: parentGoal.goalId,
                    attributes: { 'harness.level': 'warn' },
                    payload: { violations: delegated.violations },
                }),
            );
            return {
                ok: false,
                error: delegated.violations.map((item) => item.message).join('; '),
            };
        }
        const ok = delegated.results.every((item) => item.ok);
        return {
            ok,
            content: JSON.stringify(delegated.results),
            ...(!ok
                ? {
                      error: delegated.results
                          .filter((item) => !item.ok)
                          .map((item) => `${item.roleId}: ${item.error ?? 'failed'}`)
                          .join('; '),
                  }
                : {}),
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
        const base = this.baseAgentPrompt();
        const context = { rootGoalId, goalId };
        const entries =
            skillIds === undefined
                ? (this.ctx.assembly.skillProvider?.catalog(context) ?? [])
                : (this.ctx.assembly.skillProvider?.catalogFor?.(skillIds, context) ??
                  (this.ctx.assembly.skillProvider?.catalog(context) ?? []).filter((entry) =>
                      skillIds.includes(entry.id),
                  ));
        const parts = [base];
        const sessionContext = sessionContextFragment(this.ctx.assembly.workspaceRoot);
        if (sessionContext !== undefined) parts.push(sessionContext);
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

    /**
     * 某 Agent 生效的系统提示：settings.json prompts 配置优先，内置默认兜底。
     * 每轮调用前重新解析，保证「保存后新会话生效」。
     */
    private agentPrompt(id: AgentPromptId): string {
        return resolveAgentPrompt(id, this.ctx.assembly.config.agentPrompts);
    }

    /** 编码类任务追加编码 Agent 提示：只对 SuperAgent 判定的 coding/debug 任务生效。 */
    private codingPromptFragment(taskKind: PromptTaskKind): string | undefined {
        if (taskKind !== 'coding' && taskKind !== 'debug') return undefined;
        const prompt = this.agentPrompt('coding').trim();
        return prompt.length > 0 ? prompt : undefined;
    }

    /** 主执行面基础提示：宿主显式注入 > prompts.main > prompts.default > 内置 GENERAL。 */
    private baseAgentPrompt(): string {
        return (
            this.ctx.assembly.config.systemPrompt ??
            resolveBaseAgentPrompt(this.ctx.assembly.config.agentPrompts)
        );
    }

    /** 项目会话的稳定上下文：所有 triage / plan / ReAct 共享，不写进用户消息。 */
    /** Generate and mechanically validate a Task DAG; any failure falls back to single-Task MVP. */
    private async generateTaskPlan(
        rootGoalId: string,
        goal: Goal | undefined,
        model: { providerId: string; modelId: string } | undefined,
        reasoningLevel: string | undefined,
        history: readonly TaskPlannerHistoryEntry[] | undefined,
        availableTools: readonly PlanTool[],
        promptFragment: string | undefined,
    ): Promise<PlannedTask[] | undefined> {
        if (goal === undefined) return undefined;
        const configuredSteps = effectiveGoalLimits(goal).maxSteps;
        const maxTasks = Math.max(
            1,
            Math.min(
                DEFAULT_MAX_PLAN_TASKS,
                configuredSteps !== undefined
                    ? Math.floor(configuredSteps)
                    : DEFAULT_MAX_PLAN_TASKS,
            ),
        );
        const sessionContext = [
            sessionContextFragment(this.ctx.assembly.workspaceRoot),
            promptFragment,
        ]
            .filter((part): part is string => part !== undefined && part.trim().length > 0)
            .join('\n\n');
        try {
            const planner =
                this.ctx.assembly.taskPlanner ??
                createLlmTaskPlanner(async (prompt) => {
                    if (model === undefined) throw new Error('没有可用于 Task Planner 的模型');
                    const round = await withTriageTimeout(
                        this.ctx.intelligence.roundRunner.requestRound(
                            rootGoalId,
                            {
                                model,
                                messages: [
                                    { role: 'user', content: [{ type: 'text', text: prompt }] },
                                ],
                                systemPrompt: this.agentPrompt('planner'),
                                tools: [],
                            },
                            reasoningLevel,
                        ),
                        TRIAGE_TIMEOUT_MS,
                    );
                    if (round === undefined) throw new Error('Task Planner 超时');
                    return round.text;
                });
            let proposals = await planner({
                goal,
                availableTools,
                ...(sessionContext.length > 0 ? { sessionContext } : {}),
                ...(history !== undefined && history.length > 0 ? { history } : {}),
                maxTasks,
            });
            if (proposals === undefined || proposals.length === 0) return undefined;
            // 多产物目标被塌缩成单 Task 时重试一次：明确要求至少 2 个 Task。
            // 只对「成功条件里含多个独立产物/命令证据」的目标触发，避免无谓的第二次调用。
            const artifactConditions = goal.contract.successConditions.filter(
                (condition) =>
                    condition.check?.kind === 'file-exists' ||
                    condition.check?.kind === 'file-contains' ||
                    condition.check?.kind === 'command-output-contains' ||
                    condition.check?.kind === 'git-has-commit',
            ).length;
            if (proposals.length === 1 && artifactConditions >= 2) {
                const retried = await planner({
                    goal,
                    availableTools,
                    ...(sessionContext.length > 0 ? { sessionContext } : {}),
                    ...(history !== undefined && history.length > 0 ? { history } : {}),
                    strictSplit: true,
                    maxTasks,
                });
                if (retried !== undefined && retried.length > proposals.length) {
                    proposals = retried;
                }
            }
            const normalized = allocateTaskBudgets(goal, proposals);
            const compiled = compileTaskPlan({
                goals: [goal],
                proposals: normalized,
                availableTools,
            });
            if (!compiled.validation.ok) {
                this.warn(
                    `Task Planner 输出被拒绝，回退单 Task：${compiled.validation.rejected.join('；')}`,
                );
                return undefined;
            }
            return normalized;
        } catch (error) {
            this.warn(
                `Task Planner 失败，回退单 Task：${error instanceof Error ? error.message : error}`,
            );
            return undefined;
        }
    }

    /** SessionStart：runtime 直接确保项目内 Git-backed Project Wiki 骨架存在。 */
    private async ensureProjectWikiInitialized(): Promise<void> {
        if (
            this.ctx.memory.projectWiki === undefined ||
            !this.ctx.memory.projectWiki.hasGitRepository() ||
            !this.ctx.memory.projectWiki.isProjectRoot() ||
            this.ctx.memory.projectWiki.isInitialized()
        ) {
            return;
        }
        try {
            await this.ctx.memory.projectWiki.init();
        } catch (error) {
            this.warn(`Project Wiki 初始化失败：${error instanceof Error ? error.message : error}`);
        }
    }

    private warn(message: string): void {
        process.stderr.write(`[project-wiki] ${message}\n`);
    }

    private projectWikiPromptFragment(): string | undefined {
        if (this.ctx.memory.projectWiki === undefined) return undefined;
        const fragment = this.ctx.memory.projectWiki.promptFragment();
        return [
            fragment,
            '',
            'Project Wiki 由 runtime 生命周期自动维护。除非用户明确询问 Wiki，',
            '不要主动提出初始化、更新或补全 Wiki，也不要请求用户确认这类操作。',
        ].join('\n');
    }

    /** 运行边界开关审计：本次运行带了哪些 Feature、值从哪来（flag.evaluated）。 */
    /** 工具配置执行：fs.read / shell.run / CLI command / impl（经网关判权后调用）。 */
    private async executeToolConfig(
        tool: ToolConfig | undefined,
        args: Record<string, unknown>,
        skillReadRoots: readonly string[] = [],
    ): Promise<ToolCallResult> {
        const toolName = tool?.name ?? '';
        if (
            this.ctx.assembly.workspaceRoot !== undefined &&
            toolName !== 'shell.run' &&
            toolName !== 'git' &&
            toolName !== 'fs.read'
        ) {
            for (const key of ['path', 'a', 'b']) {
                const value = args[key];
                if (typeof value === 'string' && value.length > 0) {
                    try {
                        assertInsideWorkspace(this.ctx.assembly.workspaceRoot, value);
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
            const res = await fsReadToolImpl(args, this.ctx.assembly.workspaceRoot, skillReadRoots);
            return res.ok
                ? { ok: true, content: String(res.content ?? '') }
                : { ok: false, error: res.error ?? 'tool failed' };
        }
        if (toolName === 'shell.run') {
            const res = await runShellTool(args, this.ctx.assembly.workspaceRoot);
            return res.ok
                ? { ok: true, content: res.content ?? '' }
                : { ok: false, error: res.error ?? 'tool failed' };
        }
        if (tool?.command) {
            const res = await runCliTool(tool.command, args, this.ctx.assembly.workspaceRoot);
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
        skillReadRoots: readonly string[] = [],
    ): Promise<ToolCallResult> {
        const identifiers = ctx?.identifiers;
        const paths =
            this.ctx.assembly.workspaceRoot !== undefined ? effectPathsForTool(tool, args) : [];
        const before =
            paths.length > 0 && this.ctx.assembly.workspaceRoot !== undefined
                ? snapshotFiles(this.ctx.assembly.workspaceRoot, paths)
                : [];
        const result = await this.executeToolConfig(tool, args, skillReadRoots);
        if (before.length > 0 && identifiers !== undefined) {
            await this.ctx.memory.effectStore.append(
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
        return this.ctx.memory.effectStore.list(rootGoalId);
    }

    async rememberMemory(items: readonly MemoryItem[]): Promise<void> {
        await this.ctx.memory.memoryManager.remember(items);
    }

    listMemory(query = {}): Promise<readonly MemoryItem[]> {
        return this.ctx.memory.memoryManager.recall(query);
    }

    personalMemoryService(): PersonalMemoryService {
        return this.ctx.memory.personalMemory;
    }

    promptPackRegistry(): PromptPackRegistry {
        return this.ctx.assembly.promptPacks;
    }

    registerPromptPack(pack: PromptPack): void {
        this.ctx.assembly.ports.set('promptPack', pack);
        this.ctx.assembly.promptPacks.register(pack);
    }

    previewSuperAgent(input: SuperAgentInput): SuperAgentDecision {
        return this.ctx.intelligence.superAgent.decide(input);
    }

    agentRoles(): AgentRole[] {
        return this.ctx.delegation.listRoles();
    }

    registerAgentRole(role: AgentRole): void {
        this.ctx.assembly.ports.set('agentRole', role);
        this.ctx.delegation.roles.register(role);
    }

    removeAgentRole(roleId: string): boolean {
        return this.ctx.delegation.roles.remove(roleId);
    }

    delegationEdges(rootGoalId: string): Promise<DelegationEdge[]> {
        return this.ctx.delegation.coordinator.edges(rootGoalId);
    }

    setSemanticJudge(judge?: SemanticJudge): void {
        this.ctx.assembly.ports.set('semanticJudge', judge);
        this.ctx.intelligence.verifier.setSemanticJudge(judge);
    }

    setReplanPlanner(planner?: ReplanPlanner, maxReplans = 2): void {
        this.ctx.assembly.replanPlanner = planner;
        this.ctx.assembly.replanPlanner = planner;
        this.ctx.assembly.maxReplans = Math.max(0, maxReplans);
    }

    setTaskPlanner(planner?: TaskPlanner): void {
        this.ctx.assembly.taskPlanner = planner;
        this.ctx.assembly.taskPlanner = planner;
        if (planner !== undefined) this.ctx.assembly.taskPlanningByDefault = true;
    }

    verifierInfo(): { id: string; semanticJudge: boolean } {
        return {
            id: this.ctx.intelligence.verifier.id,
            semanticJudge: this.ctx.intelligence.verifier.hasSemanticJudge,
        };
    }

    async projectBlackboard(projectId: string): Promise<ProjectBlackboard | undefined> {
        if (this.ctx.assembly.workspaceRoot === undefined) return undefined;
        return this.ctx.memory.blackboard.ensure(projectId, this.ctx.assembly.workspaceRoot);
    }

    async reconcileProjectBlackboard(projectId: string): Promise<ProjectBlackboard | undefined> {
        if (this.ctx.assembly.workspaceRoot === undefined) return undefined;
        return this.ctx.memory.blackboard.reconcile(projectId, this.ctx.assembly.workspaceRoot);
    }

    async exportPortableBundle(rootGoalIds: readonly string[]): Promise<MemoryBundle> {
        const auditTrails = rootGoalIds.map((rootGoalId) => {
            const verification = this.ctx.observability.bus.verifyChain(rootGoalId);
            if (!verification.ok) {
                throw new Error(
                    `拒绝导出被篡改的审计链 ${rootGoalId}: ${verification.reason ?? 'unknown'}`,
                );
            }
            return {
                rootGoalId,
                head: verification.head ?? '',
                events: this.ctx.observability.bus.replay(rootGoalId),
            };
        });
        return exportMemoryBundle(this.ctx.memory.memoryManager, Date.now, auditTrails);
    }

    importPortableBundle(bundle: MemoryBundle): Promise<{ imported: number }> {
        return importMemoryBundle(this.ctx.memory.memoryManager, bundle);
    }

    /** Dynamic registration is pinned at the next run boundary. */
    registerTool(tool: ToolConfig): number {
        this.ctx.assembly.ports.set('tool', tool);
        return this.ctx.tools.registry.register(tool);
    }

    unregisterTool(name: string): boolean {
        return this.ctx.tools.registry.unregister(name);
    }

    /** Restore reversible file effects in reverse execution order. */
    async rollbackGoal(rootGoalId: string): Promise<EffectRecord[]> {
        return rollbackGoalEffects(
            this.ctx.memory.effectStore,
            this.ctx.observability.bus,
            this.ctx.assembly.workspaceRoot,
            rootGoalId,
        );
    }
}
