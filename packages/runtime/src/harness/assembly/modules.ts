import type { Goal } from '@mazi/core';
import { authz } from '@mazi/core';
import type { GoalTreeSnapshot } from '@mazi/libs';
import { SuperAgent } from '../../agent/index.js';
import { DelegationStack } from '../../agent/stack.js';
import { AnalysisStack } from '../../analysis/stack.js';
import { loadCommandPolicy } from '../../auth/command-policy.js';
import type { SkillProvider } from '../../capabilities/runtime.js';
import type { RuntimeConfig, ToolCallResult, ToolConfig } from '../../config.js';
import { emitFault } from '../../events/emitters.js';
import { ConsoleSink, DefaultEventBus } from '../../events/index.js';
import { StepEventEmitter } from '../../events/step-events.js';
import { DefaultFaultPipeline } from '../../faults/index.js';
import type { PlannedTask, PlanTool } from '../../gts/plan-graph.js';
import type { TaskPlannerHistoryEntry } from '../../gts/task-planner.js';
import { HookRunner, SessionLifecycle } from '../../hooks/index.js';
import { RuntimeKernel } from '../../kernel/index.js';
import { RuntimePorts } from '../../kernel/ports.js';
import { PersonalMemoryService } from '../../memory/personal-memory.js';
import { maziHome, maziPaths } from '../../paths.js';
import { memoryPlugin, PluginHost } from '../../plugins/index.js';
import type { AgentPromptId, PromptTaskKind } from '../../prompts/index.js';
import { RoundExecutor } from '../../provider/index.js';
import { configureTokenizer } from '../../token-estimator.js';
import { BUILTIN_TOOL_PRESET } from '../../tool-gateway/builtin.js';
import { RuntimeToolRegistry } from '../../tool-gateway/registry.js';
import { createConditionEnvironment } from '../../verifier/environment.js';
import { IndependentVerifier } from '../../verifier/index.js';
import { ProjectWikiService, WikiService } from '../../wiki/index.js';
import type { RunOptions } from '../conversation.js';
import { buildLlmProviders, ModelResolver } from '../model-resolver.js';

import { RuntimeResources } from '../resources.js';
import { RoundRunner } from '../round-runner.js';
import type { RuntimeContext } from '../runtime-context.js';
import { SessionFactory } from '../session-factory.js';
import { SessionIntake } from '../session-intake.js';
import { ToolPlane } from '../tool-plane.js';
import { TurnEngine } from '../turn-engine.js';

/** 装配入参：P0 纯值（配置与宿主选项）。 */
export interface AssemblyDeps {
    config: RuntimeConfig;
    options: RunOptions;
}

/** 装配桥：模块只能经这组闭包回调宿主能力，不直接持有 HarnessRuntime。 */
export interface AssemblyHost {
    beginSession(sessionId: string): Promise<void>;
    completeDirectGoal(goal: Goal, answer: string): Promise<void>;
    goalSnapshot(rootGoalId: string): Promise<GoalTreeSnapshot>;
    generateTaskPlan(
        rootGoalId: string,
        goal: Goal | undefined,
        model: { providerId: string; modelId: string } | undefined,
        reasoningLevel: string | undefined,
        history: readonly TaskPlannerHistoryEntry[] | undefined,
        availableTools: readonly PlanTool[],
        promptFragment: string | undefined,
    ): Promise<PlannedTask[] | undefined>;
    systemPromptWithSkills(
        rootGoalId: string,
        goalId: string,
        skillIds?: readonly string[],
        promptFragment?: string,
    ): string;
    agentPrompt(id: AgentPromptId): string;
    codingPromptFragment(taskKind: PromptTaskKind): string | undefined;
    projectWikiPromptFragment(): string | undefined;
    ensureProjectWikiInitialized(): Promise<void>;
    executeEffectful(
        tool: ToolConfig,
        args: Record<string, unknown>,
        context?: { identifiers?: import('@mazi/core').AuditIdentifiers },
        skillReadRoots?: readonly string[],
    ): Promise<ToolCallResult>;
    delegateAgents(
        rootGoalId: string,
        parentGoal: Goal,
        args: Record<string, unknown>,
        projectId: string | undefined,
        userId: string | undefined,
        delegationDepth: number,
    ): Promise<ToolCallResult>;
    warn(message: string): void;
}

export type AssemblySegment = 'core' | 'features';

/**
 * 一个装配模块：只写自己 owned 声明的平面键。
 *
 * 数组顺序只表达创建先后，不表达拓扑（create 相不读别人的平面）；
 * features 段允许 enabled() 条件跳过。
 */
export interface AssemblyModule {
    name: string;
    segment: AssemblySegment;
    /** 本模块负责填的平面键（点分路径），装配结束由 assertAssemblyComplete 校验。 */
    owned: readonly string[];
    /** 允许为 undefined 的键（可选能力，例如未绑定工作区时的 workspaceRoot）。 */
    optional?: readonly string[];
    enabled?(deps: AssemblyDeps): boolean;
    create(ctx: RuntimeContext, deps: AssemblyDeps, host: AssemblyHost): void;
}

const disabled = (deps: AssemblyDeps, name: string): boolean =>
    deps.options.disabledModules?.includes(name) ?? false;

export const ASSEMBLY_MODULES: readonly AssemblyModule[] = [
    {
        name: 'core-values',
        segment: 'core',
        optional: ['assembly.workspaceRoot'],
        owned: [
            'assembly.config',
            'assembly.workspaceRoot',
            'assembly.commandPolicy',
            'assembly.approvalStore',
            'assembly.maxReplans',
            'assembly.taskPlanningByDefault',
            'assembly.ports',
            'assembly.resources',
            'assembly.promptPacks',
            'session.intake',
            'session.sessionIds',
            'session.running',
            'tools.registry',
            'intelligence.superAgent',
            'intelligence.verifier',
            'observability.bus',
            'observability.hookRunner',
            'observability.lifecycle',
            'observability.faultPipeline',
        ],
        create(ctx: RuntimeContext, deps: AssemblyDeps, _host: AssemblyHost): void {
            ctx.session.sessionIds = new Map<string, string>();
            ctx.session.intake = new SessionIntake();
            ctx.session.running = new Map<string, AbortController>();
            ctx.assembly.ports = new RuntimePorts();
            ctx.assembly.approvalStore = new authz.InMemoryApprovalStore();
            ctx.assembly.maxReplans = 2;
            ctx.assembly.config = deps.config;
            ctx.assembly.commandPolicy = loadCommandPolicy(
                deps.config.authCommandPolicyFile ?? maziPaths().authCommandPolicyFile,
            ).policy;
            ctx.tools.registry = new RuntimeToolRegistry([
                ...BUILTIN_TOOL_PRESET,
                ...deps.config.tools,
            ]);
            // P3 资源只建槽不 open：prompt pack 落库同样延迟到首次读写。
            ctx.assembly.resources = new RuntimeResources(deps.config);
            ctx.assembly.promptPacks = ctx.assembly.resources.views.promptPacks;
            ctx.intelligence.superAgent = new SuperAgent(ctx.assembly.promptPacks);
            ctx.intelligence.verifier = new IndependentVerifier({
                // Lazy workspace lookup: the root is assigned a few lines below.
                environment: createConditionEnvironment(() => ctx.assembly.workspaceRoot),
            });
            configureTokenizer(deps.config.tokenizerEncoding);
            ctx.assembly.workspaceRoot = deps.options.workspaceRoot;
            ctx.assembly.ports.set('taskPlanner', deps.options.taskPlanner);
            ctx.assembly.taskPlanningByDefault =
                deps.options.taskPlanning === true || deps.options.taskPlanner !== undefined;
            ctx.observability.bus = new DefaultEventBus({
                eventDir: deps.config.eventDir,
                sessionOf: (rootGoalId) => ctx.session.sessionIds.get(rootGoalId),
            });
            ctx.observability.hookRunner = new HookRunner({
                emit: (event) => ctx.observability.bus.emit(event),
            });
            ctx.observability.lifecycle = new SessionLifecycle({
                bus: ctx.observability.bus,
                hooks: ctx.observability.hookRunner,
                sessionIds: ctx.session.sessionIds,
            });
            ctx.observability.faultPipeline = new DefaultFaultPipeline({
                emit: (type, fault, recovery) =>
                    emitFault(ctx.observability.bus, type, fault, recovery),
            });
        },
    },
    {
        name: 'stores',
        segment: 'core',
        owned: [
            'memory.goalStore',
            'memory.memoryManager',
            'memory.personalMemory',
            'memory.effectStore',
            'memory.blackboard',
            'memory.behaviorRecorder',
            'memory.questionService',
            'memory.failureLedger',
        ],
        create(ctx: RuntimeContext, _deps: AssemblyDeps, _host: AssemblyHost): void {
            // 问题/行为统一入 SQLite 权威库；JSONL 目录降级为导出/迁移来源。
            // 句柄由 RuntimeResources 延迟打开：本节只挂代理视图，构造期零 IO。
            const views = ctx.assembly.resources.views;
            ctx.memory.behaviorRecorder = views.behaviorRecorder;
            ctx.memory.questionService = views.questionService;
            ctx.memory.failureLedger = views.failureLedger;
            ctx.observability.bus.subscribe(
                { types: ['approval.requested', 'approval.granted', 'approval.cancelled'] },
                {
                    id: 'behavior-recorder',
                    handle: (event) => {
                        void ctx.memory.behaviorRecorder
                            .handleApprovalEvent(event)
                            .catch((error: unknown) => {
                                process.stderr.write(`behavior capture error: ${String(error)}\n`);
                            });
                    },
                },
            );
            ctx.memory.goalStore = views.goalStore;
            ctx.memory.memoryManager = views.memoryManager;
            ctx.memory.personalMemory = new PersonalMemoryService(views.memoryManager);
            ctx.memory.effectStore = views.effectStore;
            ctx.memory.blackboard = views.blackboard;
        },
    },
    {
        name: 'intelligence',
        segment: 'core',
        owned: [
            'intelligence.resolver',
            'intelligence.roundRunner',
            'observability.stepEvents',
            'memory.wiki',
        ],
        create(ctx: RuntimeContext, deps: AssemblyDeps, _host: AssemblyHost): void {
            ctx.intelligence.resolver = new ModelResolver(
                deps.config,
                buildLlmProviders(deps.config, deps.options),
            );
            ctx.observability.stepEvents = new StepEventEmitter(ctx.observability.bus);
            // wiki 服务同样只建槽：目录探测/索引在首次使用时付钱。
            const workspace = deps.options.workspaceRoot;
            ctx.memory.wiki = ctx.assembly.resources
                .addSlot(
                    () =>
                        new WikiService({
                            home: maziHome(),
                            ...(workspace !== undefined ? { workspace } : {}),
                            ...(deps.config.wiki ?? {}),
                        }),
                )
                .view();
            ctx.memory.projectWiki =
                workspace !== undefined
                    ? ctx.assembly.resources
                          .addSlot(() => new ProjectWikiService({ workspace }))
                          .view()
                    : undefined;
            ctx.intelligence.roundRunner = new RoundRunner({
                bus: ctx.observability.bus,
                executor: new RoundExecutor(),
                resolver: ctx.intelligence.resolver,
            });
            if (deps.config.consoleEnabled ?? false) {
                ctx.observability.bus.subscribe({}, new ConsoleSink());
            }
        },
    },
    {
        name: 'delegation',
        segment: 'features',
        owned: ['delegation'],
        enabled: (deps) => !disabled(deps, 'delegation'),
        create(ctx: RuntimeContext, deps: AssemblyDeps, _host: AssemblyHost): void {
            // 委派栈含 SQLite 句柄：只建槽，首次访问角色/协调器时才打开。
            ctx.delegation = ctx.assembly.resources
                .addSlot(() => new DelegationStack(deps.config))
                .view();
        },
    },
    {
        name: 'analysis',
        segment: 'features',
        owned: ['analysis'],
        enabled: (deps) => !disabled(deps, 'analysis'),
        create(ctx: RuntimeContext, deps: AssemblyDeps, host: AssemblyHost): void {
            ctx.analysis = ctx.assembly.resources
                .addSlot(
                    () =>
                        new AnalysisStack({
                            ...(deps.config.dbPath !== undefined
                                ? { dbPath: deps.config.dbPath }
                                : {}),
                            snapshotOf: (rootGoalId) => host.goalSnapshot(rootGoalId),
                            requestRound: (rootGoalId, roundCtx, reasoningLevel) =>
                                ctx.intelligence.roundRunner.requestRound(
                                    rootGoalId,
                                    roundCtx,
                                    reasoningLevel,
                                ),
                            resolveModelChoice: (modelId) =>
                                ctx.intelligence.resolver.resolveModelChoice(modelId),
                            systemPrompt: host.agentPrompt('iteration-analysis'),
                        }),
                )
                .view();
        },
    },
    {
        name: 'executors',
        segment: 'core',
        owned: ['session.factory', 'session.turns', 'tools.plane'],
        create(ctx: RuntimeContext, _deps: AssemblyDeps, host: AssemblyHost): void {
            ctx.session.factory = new SessionFactory({
                intake: ctx.session.intake,
                sessionIds: ctx.session.sessionIds,
                beginSession: (sessionId) => host.beginSession(sessionId),
                ...(ctx.assembly.workspaceRoot !== undefined
                    ? { workspaceRoot: ctx.assembly.workspaceRoot }
                    : {}),
                config: ctx.assembly.config,
                blackboard: ctx.memory.blackboard,
                memoryManager: ctx.memory.memoryManager,
                goalStoreDb: ctx.memory.goalStore,
                behaviorRecorder: ctx.memory.behaviorRecorder,
                labelQuestion: (questionId, text) =>
                    ctx.memory.questionService.label(questionId, text),
                bus: ctx.observability.bus,
                resolver: ctx.intelligence.resolver,
                roundRunner: ctx.intelligence.roundRunner,
                intentPrompt: () => host.agentPrompt('intent'),
            });
            ctx.tools.plane = new ToolPlane({
                config: ctx.assembly.config,
                toolRegistry: ctx.tools.registry,
                ...(ctx.assembly.workspaceRoot !== undefined
                    ? { workspaceRoot: ctx.assembly.workspaceRoot }
                    : {}),
                hooks: ctx.observability.hookRunner,
                faults: ctx.observability.faultPipeline,
                bus: ctx.observability.bus,
                approvalStore: ctx.assembly.approvalStore,
                commandPolicy: ctx.assembly.commandPolicy,
                ...(ctx.memory.projectWiki !== undefined
                    ? { projectWiki: ctx.memory.projectWiki }
                    : {}),
                wiki: ctx.memory.wiki,
                blackboard: ctx.memory.blackboard,
                delegationRoles: () => ctx.delegation?.roles,
                getSkillProvider: () => ctx.assembly.ports.get<SkillProvider>('skillProvider'),
                getApprovalSeam: () => ctx.assembly.ports.get<authz.ApprovalSeam>('approvalSeam'),
                execute: (tool, args, ctx, roots) => host.executeEffectful(tool, args, ctx, roots),
                delegate: (input) =>
                    host.delegateAgents(
                        input.rootGoalId,
                        input.parentGoal,
                        input.args,
                        input.projectId,
                        input.userId,
                        input.delegationDepth,
                    ),
            });
            ctx.session.turns = new TurnEngine({
                ctx,
                completeDirectGoal: (goal, answer) => host.completeDirectGoal(goal, answer),
                generateTaskPlan: (
                    rootGoalId,
                    goal,
                    model,
                    reasoningLevel,
                    history,
                    tools,
                    fragment,
                ) =>
                    host.generateTaskPlan(
                        rootGoalId,
                        goal,
                        model,
                        reasoningLevel,
                        history,
                        tools,
                        fragment,
                    ),
                systemPromptWithSkills: (rootGoalId, goalId, skillIds, promptFragment) =>
                    host.systemPromptWithSkills(rootGoalId, goalId, skillIds, promptFragment),
                codingPromptFragment: (kind) => host.codingPromptFragment(kind),
                projectWikiPromptFragment: () => host.projectWikiPromptFragment(),
                ensureProjectWikiInitialized: () => host.ensureProjectWikiInitialized(),
            });
        },
    },
    {
        name: 'kernel',
        segment: 'core',
        owned: ['assembly.kernel', 'assembly.plugins'],
        create(ctx: RuntimeContext, _deps: AssemblyDeps, host: AssemblyHost): void {
            ctx.assembly.kernel = new RuntimeKernel();
            ctx.assembly.kernel.provide({
                name: 'eventBus',
                create: () => ctx.observability.bus,
            });
            ctx.assembly.kernel.provide({
                name: 'faults',
                requires: ['eventBus'],
                create: () => ctx.observability.faultPipeline,
            });
            ctx.assembly.kernel.provide({
                name: 'hooks',
                requires: ['eventBus'],
                create: () => ctx.observability.hookRunner,
            });
            ctx.assembly.kernel.provide({
                name: 'tools',
                requires: ['eventBus'],
                create: () => ctx.tools.registry,
            });
            ctx.assembly.plugins = new PluginHost({
                kernel: ctx.assembly.kernel,
                hooks: ctx.observability.hookRunner,
                ports: ctx.assembly.ports,
                eventBus: ctx.observability.bus,
            });
            void ctx.assembly.plugins
                .install(memoryPlugin(ctx.memory.personalMemory))
                .catch((error) => {
                    host.warn(
                        `memory 插件安装失败：${error instanceof Error ? error.message : error}`,
                    );
                });

            ctx.assembly.kernel.provide({
                name: 'memoryManager',
                requires: ['memory'],
                create: () => ctx.memory.memoryManager,
            });
            ctx.assembly.kernel.provide({
                name: 'goalStore',
                create: () => ctx.memory.goalStore,
            });
            ctx.assembly.kernel.provide({
                name: 'behavior',
                requires: ['eventBus'],
                create: () => ctx.memory.behaviorRecorder,
            });
            ctx.assembly.kernel.provide({
                name: 'wiki',
                requires: ['eventBus'],
                create: () => ctx.memory.wiki,
            });
            ctx.assembly.kernel.provide({
                name: 'verifier',
                create: () => ctx.intelligence.verifier,
            });
            ctx.assembly.kernel.provide({
                name: 'planner',
                create: () => ctx.session.factory,
            });
            ctx.assembly.kernel.provide({
                name: 'toolPlane',
                requires: ['eventBus', 'hooks', 'faults'],
                create: () => ctx.tools.plane,
            });
            ctx.assembly.kernel.provide({ name: 'ports', create: () => ctx.assembly.ports });
            ctx.assembly.kernel.start();
        },
    },
];

/** 按点分路径取值（只读；用于 owned 校验）。 */
function resolvePath(ctx: RuntimeContext, path: string): unknown {
    return path.split('.').reduce<unknown>((value, key) => {
        if (value === undefined || value === null) return undefined;
        return (value as Record<string, unknown>)[key];
    }, ctx);
}

/**
 * 校验每个模块声明的键都已填值。生产环境跳过以保证冷启动；开发/测试环境在启动期
 * 暴露「删模块/漏填」导致的空壳，而不是等到首次使用。
 */
export function assertAssemblyComplete(
    ctx: RuntimeContext,
    modules: readonly AssemblyModule[] = ASSEMBLY_MODULES,
): void {
    if (process.env.NODE_ENV === 'production') return;
    const missing: string[] = [];
    for (const module of modules) {
        const optional = new Set(module.optional ?? []);
        for (const key of module.owned) {
            if (optional.has(key)) continue;
            if (resolvePath(ctx, key) === undefined) missing.push(`${module.name}:${key}`);
        }
    }
    if (missing.length > 0) throw new Error(`装配缺失：${missing.join(', ')}`);
}
