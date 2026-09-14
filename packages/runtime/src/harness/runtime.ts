import type {
    EventBus,
    Goal,
    LLMMessage,
    PermissionLevel,
    Step,
    Task,
    ToolSchema,
} from '@mazi/core';
import { type authz, ulid } from '@mazi/core';
import type { GoalTreeSnapshot } from '@mazi/libs';
import type { CatalogService } from '../catalog/service.js';
import type { RuntimeConfig, ToolCallResult, ToolConfig } from '../config.js';
import type { GoalToolInvoker } from '../gts/goal-executor.js';
import { type GoalStore, SqliteGoalStore } from '../memory/goal-store.js';
import { ConsoleSink, DefaultEventBus, newHarnessEvent } from '../observability/index.js';
import { RoundExecutor } from '../provider/index.js';
import { type GoalRunResult, runGoalTree } from '../strategy/goal-strategy.js';
import { configureTokenizer } from '../token-estimator.js';
import { BUILTIN_TOOL_PRESET } from '../tool-gateway/builtin.js';
import { RuntimeToolGateway } from '../tool-gateway/permission.js';
import { RuntimePolicyAuditSink } from '../tool-gateway/policy-audit.js';
import { conversationMessages, type FeedbackInput, type RunOptions } from './conversation.js';
import { buildLlmProviders, ModelResolver } from './model-resolver.js';
import { RoundRunner, type ModelRecoveryFn } from './round-runner.js';
import { StepEventEmitter } from './step-events.js';
import { fsReadToolImpl, runCliTool, runShellTool } from './tool-executor.js';

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
 * 本类只负责生命周期编排与 collaborator 组装；轮次执行归 RoundRunner，
 * 模型/计价解析归 ModelResolver，Step 事件归 StepEventEmitter，工具执行归 tool-executors。
 */
export class HarnessRuntime {
    private readonly bus: DefaultEventBus;
    private readonly goalStoreDb: GoalStore;
    private readonly resolver: ModelResolver;
    private readonly stepEvents: StepEventEmitter;
    private readonly roundRunner: RoundRunner;
    private readonly config: RuntimeConfig;
    private readonly workspaceRoot?: string;
    /** Human-in-the-loop approval seam; absent → runtime gateway uses the standing ceiling approval. */
    private approvalSeam?: authz.ApprovalSeam;
    /** 待执行 Session 的 Conversation 前置消息（create → execute 之间传递） */
    private readonly pendingHistory = new Map<string, LLMMessage[]>();
    /** 待执行 Session 的推理强度（create → execute 之间传递） */
    private readonly pendingReasoning = new Map<string, string>();
    /** 待执行 Session 的模型 id（create → execute 之间传递） */
    private readonly pendingModel = new Map<string, string>();

    constructor(config: RuntimeConfig, options: RunOptions = {}) {
        this.config = config;
        configureTokenizer(config.tokenizerEncoding);
        this.workspaceRoot = options.workspaceRoot;
        this.bus = new DefaultEventBus({ eventDir: config.eventDir });
        this.goalStoreDb = new SqliteGoalStore(config.dbPath ?? ':memory:');
        this.resolver = new ModelResolver(config, buildLlmProviders(config, options));
        this.stepEvents = new StepEventEmitter(this.bus);
        this.roundRunner = new RoundRunner({
            bus: this.bus,
            executor: new RoundExecutor(),
            resolver: this.resolver,
        });
        if (config.consoleEnabled ?? false) {
            this.bus.subscribe({}, new ConsoleSink());
        }
    }

    get eventBus(): EventBus {
        return this.bus;
    }

    /** 接入目录与账本：此后每轮 LLM 调用按钉死的 offering 价目追加 UsageRecord。 */
    setCatalog(service: CatalogService): void {
        this.roundRunner.setCatalog(service);
    }

    /** 接入模型恢复：模型名被厂商拒绝时重同步并换模重试一次（llm.error 事件后自愈）。 */
    setModelRecovery(fn: ModelRecoveryFn): void {
        this.roundRunner.setRecovery(fn);
    }

    /** 接入人审审批 seam；缺省时运行时网关回退到 ceiling 常设授权。 */
    setApprovalSeam(seam: authz.ApprovalSeam): void {
        this.approvalSeam = seam;
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
        const history = conversationMessages(opts.history);
        if (history.length > 0) {
            this.pendingHistory.set(rootGoalId, history);
        }
        if (opts.reasoningLevel) {
            this.pendingReasoning.set(rootGoalId, opts.reasoningLevel);
        }
        if (opts.modelId) {
            this.pendingModel.set(rootGoalId, opts.modelId);
        }
        const goalId = ulid();
        const ceiling =
            opts.permissionCeiling ?? this.config.goal?.permissionCeiling ?? 'read-only';
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
        // 每轮 run 重置上下文基线：首个 round 的 delta 从 0 起算，不与上一个会话串味。
        this.roundRunner.resetBaselines();
        const history = this.pendingHistory.get(rootGoalId) ?? [];
        this.pendingHistory.delete(rootGoalId);
        const reasoningLevel = this.pendingReasoning.get(rootGoalId);
        this.pendingReasoning.delete(rootGoalId);
        const modelId = this.pendingModel.get(rootGoalId);
        this.pendingModel.delete(rootGoalId);
        const model = this.resolver.resolveModelChoice(modelId);
        const workGoal = goals.find((goal) => goal.kind === 'work');
        const exec = this.goalExecutionConfig(
            rootGoalId,
            workGoal?.goalId ?? rootGoalId,
            workGoal?.permissionCeiling ?? this.config.goal?.permissionCeiling ?? 'read-only',
        );
        const result = await runGoalTree(
            {
                store: this.goalStoreDb,
                requestRound: (ctx) =>
                    this.roundRunner.requestRound(rootGoalId, ctx, reasoningLevel),
                systemPrompt: this.config.systemPrompt ?? DEFAULT_AGENT_SYSTEM_PROMPT,
                tools: exec.tools,
                invoker: exec.invoker,
                allowedTools: exec.allowedTools,
                ...(history.length > 0 ? { history } : {}),
                ...(model ? { model } : {}),
                ...(this.workspaceRoot !== undefined ? { workspaceRoot: this.workspaceRoot } : {}),
                onStep: (step) => this.stepEvents.emitStep(rootGoalId, step),
            },
            goals,
        );
        // Settle the Goal entities so the persisted tree/snapshot no longer reports
        // every goal as 'active' after the run has finished.
        const outcomeByGoal = new Map(
            result.tasks.map((outcome) => [outcome.task.goalId, outcome]),
        );
        for (const goal of goals) {
            const settled = result.ok ? 'succeeded' : 'failed';
            if (goal.kind === 'work') {
                goal.status = outcomeByGoal.get(goal.goalId)?.ok ? 'succeeded' : 'failed';
            } else if (goal.kind === 'intake') {
                goal.status = settled;
            } else {
                continue;
            }
            await this.goalStoreDb.saveGoal(goal);
        }
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
        const { snapshotGoalTree } = await import('../observability/goal-snapshot.js');
        return snapshotGoalTree(rootGoalId, goals, tasks, steps);
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

    /**
     * Goal 执行的工具面：内置 CLI 预设 + config.tools → 经 v2 ToolGateway 判权的
     * ToolSchema/执行器/白名单。supply 视图只暴露当前 permissionCeiling 允许的工具；
     * 白名单缺省 = 全部可见工具；显式空数组 = 纯对话（不注入工具 schema）。
     */
    private goalExecutionConfig(
        rootGoalId: string,
        goalId: string,
        level: PermissionLevel,
    ): {
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
        const gateway = new RuntimeToolGateway({
            rootGoalId,
            goalId,
            taskId: goalId,
            level,
            tools: merged,
            execute: (tool, args) => this.executeToolConfig(tool, args),
            ...(this.workspaceRoot !== undefined ? { workspaceRoot: this.workspaceRoot } : {}),
            audit: new RuntimePolicyAuditSink({ emit: (event) => this.bus.emit(event) }),
            ...(this.approvalSeam ? { approval: this.approvalSeam } : {}),
        });
        const visible = new Set(gateway.visibleToolNames());
        const configured = this.config.goal?.allowedTools;
        const names = (configured === undefined ? merged.map((t) => t.name) : configured).filter(
            (name) => visible.has(name),
        );
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
        return { tools, invoker: { invoke }, allowedTools: names };
    }

    /** 工具配置执行：fs.read / shell.run / CLI command / impl（经网关判权后调用）。 */
    private async executeToolConfig(
        tool: ToolConfig | undefined,
        args: Record<string, unknown>,
    ): Promise<ToolCallResult> {
        const toolName = tool?.name ?? '';
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
}
