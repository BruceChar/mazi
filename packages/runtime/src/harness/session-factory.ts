import type { Goal } from '@mazi/core';
import { ulid } from '@mazi/core';
import type { ProjectBlackboardService } from '../blackboard/index.js';
import { projectIdForWorkspace } from '../blackboard/index.js';
import type { RuntimeConfig } from '../config.js';
import { emitGoalPhase } from '../events/emitters.js';
import type { DefaultEventBus } from '../events/event-bus.js';
import { newHarnessEvent } from '../events/index.js';
import {
    baselineConditions,
    type ParsedGoalPlan,
    parseGoalParserOutput,
    planNegotiation,
} from '../gts/negotiation.js';
import type { GoalStore } from '../memory/goal-store.js';
import { type MemoryManager, turnsToMemory } from '../memory/memory.js';
import type { BehaviorRecorder } from '../observability/behavior-recorder.js';
import { conversationMessages, type RunOptions } from './conversation.js';
import type { ModelResolver } from './model-resolver.js';
import type { RoundRunner } from './round-runner.js';
import { sessionContextFragment } from './session-context.js';
import type { SessionIntake } from './session-intake.js';
import { TRIAGE_TIMEOUT_MS, withTriageTimeout } from './triage-support.js';

/**
 * SessionFactory —— 会话创建与 intent triage（从 HarnessRuntime 抽出）。
 *
 * 创建必须立即返回（用户消息不能等模型）；triage 只是增强，异步调度、
 * 超时/失败一律回落默认执行，执行入口再 await 尚未落地的 triage。
 */
export interface SessionFactoryDeps {
    intake: SessionIntake;
    sessionIds: Map<string, string>;
    beginSession: (sessionId: string) => Promise<void>;
    workspaceRoot?: string;
    config: RuntimeConfig;
    blackboard: ProjectBlackboardService;
    memoryManager: MemoryManager;
    goalStoreDb: GoalStore;
    behaviorRecorder: BehaviorRecorder;
    labelQuestion: (questionId: string, text: string) => Promise<void>;
    bus: DefaultEventBus;
    resolver: ModelResolver;

    roundRunner: RoundRunner;
    /** goal-parser 模板（可被宿主覆盖，故用 getter）。 */
    intentPrompt: () => string;
}

export class SessionFactory {
    constructor(private readonly d: SessionFactoryDeps) {}
    /** 创建 Goal 会话（单 Goal：user intent 直接产 Goal）并持久化；发 goal.started */
    async create(
        input: string,
        opts: RunOptions = {},
    ): Promise<{ rootGoalId: string; goalId: string }> {
        const rootGoalId = ulid();
        if (opts.conversationId !== undefined) {
            this.d.intake.pendingSessionId.set(rootGoalId, opts.conversationId);
            this.d.sessionIds.set(rootGoalId, opts.conversationId);
            await this.d.beginSession(opts.conversationId);
        }
        const workspaceId = opts.workspaceRoot ?? this.d.workspaceRoot;
        const projectId =
            opts.projectId ??
            (workspaceId !== undefined ? projectIdForWorkspace(workspaceId) : undefined);
        const memoryContext = {
            ...(opts.conversationId !== undefined ? { conversationId: opts.conversationId } : {}),
            ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
            ...(workspaceId !== undefined ? { workspaceId } : {}),
            ...(projectId !== undefined ? { projectId } : {}),
        };
        this.d.intake.pendingMemoryContext.set(rootGoalId, memoryContext);
        if (projectId !== undefined && workspaceId !== undefined) {
            if (opts.projectId !== undefined) {
                this.d.intake.pendingProjectContext.set(rootGoalId, { workspace: workspaceId });
            }
            this.d.intake.pendingBlackboard.set(rootGoalId, {
                projectId,
                workspace: workspaceId,
            });
            await this.d.blackboard.ensure(projectId, workspaceId);
        }
        if (opts.history !== undefined && opts.history.length > 0) {
            await this.d.memoryManager.remember(
                turnsToMemory(opts.history, {
                    rootGoalId,
                    ...memoryContext,
                    provenance: { source: 'user', confidence: 'confirmed', trustTier: 'T1' },
                }),
            );
            // Planner needs the same conversation context triage gets: a short input
            // such as "A" is only meaningful relative to the previous turns.
            this.d.intake.pendingHistory.set(
                rootGoalId,
                opts.history.map((turn) => ({ role: turn.role, text: turn.text })),
            );
        }
        if (opts.reasoningLevel) {
            this.d.intake.pendingReasoning.set(rootGoalId, opts.reasoningLevel);
        }
        if (opts.modelId) {
            this.d.intake.pendingModel.set(rootGoalId, opts.modelId);
        }
        if (opts.promptFragment !== undefined && opts.promptFragment.length > 0) {
            this.d.intake.pendingPromptFragment.set(rootGoalId, opts.promptFragment);
        }
        if (opts.skillIds !== undefined) {
            this.d.intake.pendingSkills.set(rootGoalId, opts.skillIds);
        }
        if (opts.allowedTools !== undefined) {
            this.d.intake.pendingAllowedTools.set(rootGoalId, opts.allowedTools);
        }
        if (opts.planProposal !== undefined) {
            this.d.intake.pendingPlanProposal.set(
                rootGoalId,
                opts.planProposal.map((task) => ({
                    ...task,
                    goalId: task.goalId ?? (rootGoalId as NonNullable<typeof task.goalId>),
                })),
            );
        }
        if (opts.taskPlanning !== undefined) {
            this.d.intake.pendingTaskPlanning.set(rootGoalId, opts.taskPlanning);
        }
        if (opts.loopMode !== undefined) {
            this.d.intake.pendingLoopMode.set(rootGoalId, opts.loopMode);
        }
        if (opts.promptPackIds !== undefined) {
            this.d.intake.pendingPromptPackIds.set(rootGoalId, opts.promptPackIds);
        }
        this.d.intake.pendingDelegationDepth.set(
            rootGoalId,
            Math.max(0, opts.delegationDepth ?? 0),
        );
        if (opts.flagOverrides !== undefined) {
            this.d.intake.pendingFlags.set(rootGoalId, {
                values: { ...opts.flagOverrides },
                trace: (opts.flagTrace ?? []).map((step) => ({ ...step })),
            });
        }
        const ceiling =
            opts.permissionCeiling ?? this.d.config.goal?.permissionCeiling ?? 'read-only';
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
        await this.d.goalStoreDb.saveGoal(goal);
        const recorded = await this.d.behaviorRecorder.recordInput(rootGoalId, input, {
            ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
            ...(opts.conversationId !== undefined ? { conversationId: opts.conversationId } : {}),
        });
        const question = recorded[0];
        if (question !== undefined) {
            await this.d.labelQuestion(`${rootGoalId}:${question.ts}`, input);
        }
        this.d.bus.emit(
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
        await this.d.bus.flush();
        // 异步 triage：创建请求不等待；执行入口会 await 尚未落地的 triage，保证
        // Task Planner 看到的是完整契约（含 goals/constraints 与 route）。
        if (opts.parseIntent === true) {
            // 可观测性：triage 是首个 Step 之前的一次模型轮次，先让 UI 进入「理解任务」阶段。
            await emitGoalPhase(this.d.bus, rootGoalId, rootGoalId, 'intake', '正在理解任务');
            this.d.intake.pendingTriage.set(
                rootGoalId,
                this.scheduleTriage(rootGoalId, input, opts),
            );
        }
        return { rootGoalId, goalId: rootGoalId };
    }

    /** 异步 triage：失败/超时只是不协商，绝不影响会话创建与执行。 */
    private scheduleTriage(rootGoalId: string, statement: string, opts: RunOptions): Promise<void> {
        const task = this.applyTriage(rootGoalId, statement, opts)
            .catch(() => undefined)
            .finally(() => {
                // 完成后即可移除：契约已落库，execute 重新加载 Goal 就能看到。
                this.d.intake.pendingTriage.delete(rootGoalId);
            });
        return task;
    }

    /**
     * triage 结果落地：读改写当前 Goal，只在尚未有协商结论时合并（幂等）。
     * 追加的语义条款是纯增量，不会让已生成的 Task.acceptance / Step 归因失效。
     */
    private async applyTriage(
        rootGoalId: string,
        statement: string,
        opts: RunOptions,
    ): Promise<void> {
        const parsed = await this.parseIntent(statement, rootGoalId, opts);
        // 无可用模型/超时/解析失败：triage 视为未发生，不写任何协商结论。
        if (parsed === undefined) return;
        const plan = planNegotiation(parsed);
        const goal = await this.d.goalStoreDb.loadGoal(rootGoalId);
        if (goal === undefined || goal.negotiation !== undefined) return;
        // 基线两条机械条款在创建时已冻结；triage 只会新增：
        // - semantic 条款（需 judge），
        // - 带结构化 check 的 deterministic 条款（P2：file/git/命令输出可机械判定）。
        // 不能只留 semantic，否则 triage 产出的机械检查会被静默丢弃。
        const added = plan.conditions.filter(
            (condition) =>
                condition.checkType === 'semantic' ||
                (condition.check !== undefined &&
                    condition.check.kind !== 'final-answer' &&
                    condition.check.kind !== 'no-failed-steps'),
        );
        goal.contract = {
            ...goal.contract,
            successConditions: [...goal.contract.successConditions, ...added],
        };
        goal.negotiation = plan.negotiation;
        await this.d.goalStoreDb.saveGoal(goal);
        if (plan.negotiation.route !== 'negotiate' && plan.negotiation.route !== 'escalate') return;
        this.d.bus.emit(
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
        await this.d.bus.flush();
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
        const model = this.d.resolver.resolveModelChoice(opts.modelId) ?? this.defaultModelChoice();
        if (model === undefined) return undefined;
        // triage 是"增强"，不能成为主流程的阻塞点：超时/失败/无输出一律回落默认执行
        const round = await withTriageTimeout(
            this.d.roundRunner.requestRound(
                rootGoalId,
                {
                    model,
                    messages: [
                        ...conversationMessages(opts.history),
                        { role: 'user', content: [{ type: 'text', text: statement }] },
                    ],
                    systemPrompt:
                        this.d.intentPrompt() +
                        (sessionContextFragment(opts.workspaceRoot ?? this.d.workspaceRoot) ?? ''),
                    tools: [],
                },
                opts.reasoningLevel,
            ),
            TRIAGE_TIMEOUT_MS,
        );
        if (round === undefined) return undefined;
        return parseGoalParserOutput(round.text);
    }

    /** 默认模型：无显式 modelId 时由 ModelResolver 取首个可用 provider。 */
    defaultModelChoice(): { providerId: string; modelId: string } | undefined {
        return this.d.resolver.defaultModelChoice();
    }
}
