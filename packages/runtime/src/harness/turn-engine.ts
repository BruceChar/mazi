import { type Goal, type Step, ulid } from '@mazi/core';
import { projectIdForWorkspace } from '../blackboard/index.js';
import type { SkillProvider } from '../capabilities/runtime.js';
import { emitFlagEvent, emitGoalPhase, emitSkillEvent } from '../events/emitters.js';
import { newHarnessEvent } from '../events/index.js';
import { rollupAcceptance } from '../gts/acceptance.js';
import type { PlannedTask } from '../gts/plan-graph.js';
import type { ReplanPlanner } from '../gts/replan.js';
import type { TaskPlannerHistoryEntry } from '../gts/task-planner.js';
import type { PromptRiskLevel, PromptTaskKind } from '../prompts/index.js';
import { type GoalRunResult, runGoalTree } from '../strategy/goal-strategy.js';
import type { VerificationFailureCategory, VerificationReport } from '../verifier/index.js';
import type { RuntimeContext } from './runtime-context.js';

/**
 * TurnEngine —— Goal 轮次的执行主干（从 HarnessRuntime 的
 * executeGoalTree / executeGoalTreeBody 移出）。
 *
 * 只依赖宿主暴露的协作者与只读状态；可变的装配点（工作区、技能、
 * 规划器）走 getter，保证运行期 setter 仍然生效。
 */
export interface TurnEngineHost {
    /** 唯一协作者入口：所有读写经 ctx 平面，宿主不再逐项转发字段。 */
    readonly ctx: RuntimeContext;
    completeDirectGoal(goal: Goal, answer: string): Promise<void>;
    generateTaskPlan(
        rootGoalId: string,
        goal: Goal | undefined,
        model: { providerId: string; modelId: string } | undefined,
        reasoningLevel: string | undefined,
        history: readonly TaskPlannerHistoryEntry[] | undefined,
        availableTools: readonly import('../gts/plan-graph.js').PlanTool[],
        promptFragment: string | undefined,
    ): Promise<PlannedTask[] | undefined>;
    systemPromptWithSkills(
        rootGoalId: string,
        goalId: string,
        skillIds?: readonly string[],
        promptFragment?: string,
    ): string;
    codingPromptFragment(taskKind: PromptTaskKind): string | undefined;
    projectWikiPromptFragment(): string | undefined;
    ensureProjectWikiInitialized(): Promise<void>;
}

export class TurnEngine {
    constructor(private readonly h: TurnEngineHost) {}
    async run(rootGoalId: string, options: { resume?: boolean } = {}): Promise<GoalRunResult> {
        try {
            const result = await this.body(rootGoalId, options);
            await this.finishTurn(rootGoalId, result);
            return result;
        } catch (error) {
            await this.finishTurn(rootGoalId, undefined, error);
            throw error;
        }
    }

    /** 轮次收尾：turn.end 钩子（异步副作用点）+ turn.ended 事实事件。 */
    private async finishTurn(
        rootGoalId: string,
        result?: GoalRunResult,
        error?: unknown,
    ): Promise<void> {
        await this.h.ctx.observability.lifecycle.endTurn(rootGoalId, {
            ...(result !== undefined ? { result } : {}),
            ...(error !== undefined ? { error } : {}),
        });
    }

    private async body(
        rootGoalId: string,
        options: { resume?: boolean } = {},
    ): Promise<GoalRunResult> {
        // Planning must not race the async triage: wait for the in-flight triage
        // (bounded by TRIAGE_TIMEOUT_MS inside parseIntent) so the contract,
        // route and semantic conditions are final before a plan is generated.
        const triage = this.h.ctx.session.intake.pendingTriage.get(rootGoalId);
        if (triage !== undefined) {
            await triage;
            this.h.ctx.session.intake.pendingTriage.delete(rootGoalId);
        }
        const history = this.h.ctx.session.intake.pendingHistory.get(rootGoalId);
        this.h.ctx.session.intake.pendingHistory.delete(rootGoalId);
        const goals = await this.h.ctx.memory.goalStore.listGoalsByRoot(rootGoalId);
        if (goals.length === 0) {
            throw new Error(`Goal 树不存在：${rootGoalId}`);
        }
        const resume = options.resume === true;
        // 上下文 delta 基线由每个 Task 的 ContextManager 自己持有，无需跨 run 重置。
        const reasoningLevel = this.h.ctx.session.intake.pendingReasoning.get(rootGoalId);
        this.h.ctx.session.intake.pendingReasoning.delete(rootGoalId);
        const modelId = this.h.ctx.session.intake.pendingModel.get(rootGoalId);
        this.h.ctx.session.intake.pendingModel.delete(rootGoalId);
        let promptFragment = this.h.ctx.session.intake.pendingPromptFragment.get(rootGoalId);
        this.h.ctx.session.intake.pendingPromptFragment.delete(rootGoalId);
        const requestedSkills = this.h.ctx.session.intake.pendingSkills.get(rootGoalId);
        this.h.ctx.session.intake.pendingSkills.delete(rootGoalId);
        const skillIds =
            requestedSkills ??
            this.h.ctx.assembly.ports.get<SkillProvider>('skillProvider')?.mounted() ??
            [];
        const projectWikiActive = this.h.ctx.memory.projectWiki !== undefined;
        const allowedToolsOverride = this.h.ctx.session.intake.pendingAllowedTools.get(rootGoalId);
        this.h.ctx.session.intake.pendingAllowedTools.delete(rootGoalId);
        const planProposal = this.h.ctx.session.intake.pendingPlanProposal.get(rootGoalId);
        this.h.ctx.session.intake.pendingPlanProposal.delete(rootGoalId);
        const taskPlanning =
            this.h.ctx.session.intake.pendingTaskPlanning.get(rootGoalId) ??
            this.h.ctx.assembly.taskPlanningByDefault;
        this.h.ctx.session.intake.pendingTaskPlanning.delete(rootGoalId);
        const memoryContext = this.h.ctx.session.intake.pendingMemoryContext.get(rootGoalId) ?? {};
        this.h.ctx.session.intake.pendingMemoryContext.delete(rootGoalId);
        const explicitPromptPackIds =
            this.h.ctx.session.intake.pendingPromptPackIds.get(rootGoalId);
        this.h.ctx.session.intake.pendingPromptPackIds.delete(rootGoalId);
        const delegationDepth =
            this.h.ctx.session.intake.pendingDelegationDepth.get(rootGoalId) ?? 0;
        this.h.ctx.session.intake.pendingDelegationDepth.delete(rootGoalId);
        const flags = this.h.ctx.session.intake.pendingFlags.get(rootGoalId);
        this.h.ctx.session.intake.pendingFlags.delete(rootGoalId);
        const model = this.h.ctx.intelligence.resolver.resolveModelChoice(modelId);
        const sessionId = this.h.ctx.session.intake.pendingSessionId.get(rootGoalId);
        this.h.ctx.session.intake.pendingSessionId.delete(rootGoalId);
        this.h.ctx.session.intake.pendingProjectContext.delete(rootGoalId);
        const rootGoal = goals.find((goal) => goal.goalId === rootGoalId) ?? goals[0];
        const goalId = rootGoal?.goalId ?? rootGoalId;
        const directAnswer =
            !resume && rootGoal?.negotiation?.route === 'direct'
                ? rootGoal.negotiation.directAnswer?.trim()
                : undefined;
        // 轮次开始：生命周期模块负责 turn.start 钩子与 turn.started 事实。
        const contextAppend = await this.h.ctx.observability.lifecycle.startTurn({
            rootGoalId,
            goalId,
            ...(sessionId !== undefined ? { sessionId } : {}),
            statement: rootGoal?.statement ?? '',
            route: rootGoal?.negotiation?.route ?? 'task',
        });
        if (contextAppend !== undefined) {
            promptFragment = [promptFragment, contextAppend]
                .filter((part): part is string => typeof part === 'string' && part.length > 0)
                .join('\n\n');
        }
        if (rootGoal !== undefined && directAnswer) {
            this.h.ctx.session.intake.pendingBlackboard.delete(rootGoalId);
            await this.h.completeDirectGoal(rootGoal, directAnswer);
            return {
                rootGoalId,
                tasks: [],
                ok: true,
                finalAnswer: directAnswer,
            };
        }
        if (projectWikiActive) {
            await this.h.ensureProjectWikiInitialized();
        }
        const blackboardContext =
            this.h.ctx.session.intake.pendingBlackboard.get(rootGoalId) ??
            (this.h.ctx.assembly.workspaceRoot !== undefined
                ? {
                      projectId: projectIdForWorkspace(this.h.ctx.assembly.workspaceRoot),
                      workspace: this.h.ctx.assembly.workspaceRoot,
                  }
                : undefined);
        const board =
            blackboardContext !== undefined
                ? await this.h.ctx.memory.blackboard.ensure(
                      blackboardContext.projectId,
                      blackboardContext.workspace,
                  )
                : undefined;
        const blackboardFragment =
            board !== undefined ? this.h.ctx.memory.blackboard.promptFragment(board) : undefined;
        const exec = this.h.ctx.tools.plane.config({
            rootGoalId,
            goalId,
            level:
                rootGoal?.permissionCeiling ??
                this.h.ctx.assembly.config.goal?.permissionCeiling ??
                'read-only',
            ...(sessionId !== undefined ? { sessionId } : {}),
            ...(allowedToolsOverride !== undefined ? { allowedToolsOverride } : {}),
            ...(blackboardContext?.projectId !== undefined
                ? { projectId: blackboardContext.projectId }
                : {}),
            ...(rootGoal !== undefined ? { parentGoal: rootGoal } : {}),
            ...(memoryContext.userId !== undefined ? { userId: memoryContext.userId } : {}),
            delegationDepth,
            ...(skillIds.length > 0 ? { activeSkillIds: skillIds } : {}),
        });
        const decision = this.h.ctx.intelligence.superAgent.decide({
            ...(memoryContext.userId !== undefined ? { userId: memoryContext.userId } : {}),
            ...(blackboardContext?.projectId !== undefined
                ? { projectId: blackboardContext.projectId }
                : {}),
            ...(this.h.ctx.assembly.workspaceRoot !== undefined
                ? { workspace: this.h.ctx.assembly.workspaceRoot }
                : {}),
            input: rootGoal?.statement ?? '',
            tools: exec.allowedTools,
            riskLevel: riskLevelOfGoal(rootGoal),
            ...(explicitPromptPackIds !== undefined
                ? { explicitPackIds: explicitPromptPackIds }
                : {}),
        });
        const promptPackFragment = decision.promptMatch.prompt;
        this.h.ctx.observability.bus.emit(
            newHarnessEvent({
                type: 'superagent.decision',
                rootGoalId,
                goalId,
                attributes: { 'harness.level': 'info' },
                payload: {
                    taskKind: decision.taskKind,
                    riskLevel: decision.riskLevel,
                    promptPackIds: decision.promptPackIds,
                    plannerId: decision.plannerId,
                    verifierId: decision.verifierId,
                    memoryPlan: decision.memoryPlan,
                    blackboardRequired: decision.blackboardRequired,
                    reason: decision.reason,
                },
            }),
        );
        this.h.ctx.observability.bus.emit(
            newHarnessEvent({
                type: 'prompt.pack.selected',
                rootGoalId,
                goalId,
                attributes: { 'harness.level': 'info' },
                payload: {
                    selected: decision.promptMatch.selected.map((pack) => ({
                        id: pack.id,
                        version: pack.version,
                    })),
                    trace: decision.promptMatch.trace,
                    estimatedTokens: decision.promptMatch.estimatedTokens,
                },
            }),
        );
        this.h.ctx.observability.bus.emit(
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
        // Runtime-owned Project Wiki supersedes the legacy MAZI_HOME snapshot.
        const wikiFragment = projectWikiActive ? '' : this.h.ctx.memory.wiki.promptFragment();
        const projectWikiFragment = projectWikiActive
            ? this.h.projectWikiPromptFragment()
            : undefined;
        const willGeneratePlan =
            planProposal === undefined &&
            !resume &&
            taskPlanning &&
            exec.allowedTools.length > 0 &&
            rootGoal?.negotiation?.route !== 'direct';
        if (willGeneratePlan) {
            // 可观测性：计划生成同样是首个 Step 之前的模型轮次，先让 UI 显示「制定计划」。
            await emitGoalPhase(
                this.h.ctx.observability.bus,
                rootGoalId,
                goalId,
                'planning',
                '正在制定计划',
            );
        }
        const effectivePlanProposal =
            planProposal ??
            (willGeneratePlan
                ? await this.h.generateTaskPlan(
                      rootGoalId,
                      rootGoal,
                      model ?? this.h.ctx.session.factory.defaultModelChoice(),
                      reasoningLevel,
                      history,
                      exec.planTools,
                      promptFragment,
                  )
                : undefined);
        // 挂载是用户级开关；每次运行在边界发能力事件，审计锚定本次 run。
        // 运行级 skillIds 覆盖（实验臂）优先于全局挂载状态。
        for (const skillId of skillIds) {
            emitSkillEvent(
                this.h.ctx.observability.bus,
                'capability.activated',
                skillId,
                rootGoalId,
                goalId,
            );
        }
        if (flags !== undefined && Object.keys(flags.values).length > 0) {
            emitFlagEvent(
                this.h.ctx.observability.bus,
                rootGoalId,
                goalId,
                flags.values,
                flags.trace,
            );
        }
        // 普通会话保持计划稳定：失败不自动改写 Task 图。Replan 只能由宿主显式注入，
        // 用于实验或需要人工确认恢复策略的高级路径。
        const replanPlanner = this.h.ctx.assembly.ports.get<ReplanPlanner>('replanPlanner');
        const verificationByTask = new Map<string, VerificationReport>();
        const controller = new AbortController();
        this.h.ctx.session.running.set(rootGoalId, controller);
        let result: GoalRunResult;
        try {
            result = await runGoalTree(
                {
                    store: this.h.ctx.memory.goalStore,
                    requestRound: (ctx) =>
                        this.h.ctx.intelligence.roundRunner.requestRound(
                            rootGoalId,
                            ctx,
                            reasoningLevel,
                            sessionId,
                        ),
                    systemPrompt: this.h.systemPromptWithSkills(
                        rootGoalId,
                        goalId,
                        requestedSkills,
                        combinePromptFragments(
                            promptFragment,
                            wikiFragment,
                            projectWikiFragment,
                            blackboardFragment,
                            promptPackFragment,
                            this.h.codingPromptFragment(decision.taskKind),
                        ),
                    ),
                    tools: exec.tools,
                    invoker: exec.invoker,
                    allowedTools: exec.allowedTools,
                    memory: this.h.ctx.memory.memoryManager,
                    memoryQuery: {
                        rootGoalId,
                        ...memoryContext,
                        queryText: rootGoal?.statement ?? '',
                    },
                    memoryWriteContext: memoryContext,
                    ...(effectivePlanProposal !== undefined
                        ? { planProposal: effectivePlanProposal }
                        : {}),
                    planTools: exec.planTools,
                    ...(model ? { model } : {}),
                    ...(this.h.ctx.assembly.workspaceRoot !== undefined
                        ? { workspaceRoot: this.h.ctx.assembly.workspaceRoot }
                        : {}),
                    ...(resume ? { resume: true } : {}),
                    signal: controller.signal,
                    verifier: this.h.ctx.intelligence.verifier,
                    ...(replanPlanner !== undefined
                        ? {
                              replan: {
                                  planner: replanPlanner,
                                  availableTools: exec.planTools,
                                  maxReplans: this.h.ctx.assembly.maxReplans,
                              },
                          }
                        : {}),
                    onVerification: (report, outcome) => {
                        verificationByTask.set(outcome.task.taskId, report);
                        this.h.ctx.observability.bus.emit(
                            newHarnessEvent({
                                type: 'verification.completed',
                                rootGoalId,
                                goalId: outcome.task.goalId,
                                taskId: outcome.task.taskId,
                                attributes: {
                                    'harness.level': report.state === 'failed' ? 'warn' : 'info',
                                },
                                payload: {
                                    verifierId: report.verifierId,
                                    state: report.state,
                                    failureCategory: report.failureCategory,
                                    semanticJudgeId: report.semanticJudgeId,
                                    acceptance: report.acceptance,
                                    evidence: report.evidence.map((item) => item.slice(0, 1000)),
                                },
                            }),
                        );
                    },
                    onReplan: (revision, rejected, warnings) => {
                        this.h.ctx.observability.bus.emit(
                            newHarnessEvent({
                                type: revision !== undefined ? 'plan.revised' : 'replan.rejected',
                                rootGoalId,
                                goalId,
                                attributes: {
                                    'harness.level': revision !== undefined ? 'info' : 'warn',
                                },
                                payload:
                                    revision !== undefined
                                        ? {
                                              revision: revision.revision,
                                              // 计划版本：初始 = 1，第 N 次 Replan = N + 1；UI 按它过滤当前计划。
                                              planVersion: revision.planVersion,
                                              diff: revision.diff,
                                              reason: revision.reason,
                                              evidence: revision.evidence,
                                              digest: revision.digest,
                                              ...(revision.warnings !== undefined
                                                  ? { warnings: revision.warnings }
                                                  : {}),
                                              // 修订后的完整 Task 列表：UI 无需再等 timeline 刷新即可渲染新计划。
                                              tasks: revision.tasks.map((task) => ({
                                                  taskId: task.taskId,
                                                  title: task.title,
                                                  dependsOn: task.dependsOn ?? [],
                                                  planVersion:
                                                      task.planVersion ?? revision.planVersion,
                                                  status: task.status,
                                              })),
                                          }
                                        : {
                                              rejected,
                                              ...(warnings !== undefined && warnings.length > 0
                                                  ? { warnings }
                                                  : {}),
                                          },
                            }),
                        );
                    },
                    onStep: (step) => {
                        this.h.ctx.observability.stepEvents.emitStep(rootGoalId, step);
                        if (this.h.ctx.memory.projectWiki === undefined)
                            this.h.ctx.memory.wiki.observeStep(step);
                    },
                    onPlan: (taskCount, digest, rejected, tasks) => {
                        const planVersion =
                            tasks !== undefined && tasks.length > 0
                                ? Math.max(...tasks.map((task) => task.planVersion ?? 1))
                                : 1;
                        this.h.ctx.observability.bus.emit(
                            newHarnessEvent({
                                type: rejected === undefined ? 'plan.created' : 'plan.invalid',
                                rootGoalId,
                                goalId,
                                attributes: {
                                    'harness.level': rejected === undefined ? 'info' : 'warn',
                                },
                                payload:
                                    rejected === undefined
                                        ? {
                                              taskCount,
                                              digest,
                                              // 初始计划 = 1；恢复运行沿用计划自身的版本。
                                              planVersion,
                                              // 计划可观测：Task 标题/依赖/版本让 UI 与复盘能审计 TaskPlan。
                                              tasks: (tasks ?? []).map((task) => ({
                                                  taskId: task.taskId,
                                                  title: task.title,
                                                  dependsOn: task.dependsOn ?? [],
                                                  planVersion: task.planVersion ?? planVersion,
                                              })),
                                          }
                                        : { taskCount, rejected },
                            }),
                        );
                    },
                    onExecutionStart: () =>
                        emitGoalPhase(
                            this.h.ctx.observability.bus,
                            rootGoalId,
                            goalId,
                            'executing',
                            '正在执行',
                        ),
                },
                goals,
            );
        } finally {
            this.h.ctx.session.running.delete(rootGoalId);
            for (const skillId of skillIds) {
                emitSkillEvent(
                    this.h.ctx.observability.bus,
                    'capability.deactivated',
                    skillId,
                    rootGoalId,
                    goalId,
                );
            }
        }
        const aborted = result.tasks.some((outcome) => outcome.reason === 'aborted');
        // Settle the Goal entities so the persisted tree/snapshot no longer reports
        // every active goal as 'active' after the run has finished. Aborted runs stay
        // resumable (Goal.status='aborted') instead of being marked failed.
        // 没有 TaskOutcome 的 Goal（blocked 待协商 / pending）保持原状态：
        // 它们根本没进入本次执行，不能被一次「空运行」改写成 succeeded。
        const outcomeByGoal = new Map(
            result.tasks.map((outcome) => [outcome.task.goalId, outcome]),
        );
        for (const goal of goals) {
            const outcome = outcomeByGoal.get(goal.goalId);
            if (outcome === undefined) continue;
            // 读改写最新行：异步 triage 可能刚把协商结论/语义条款写进同一个 Goal，
            // 不能用运行开始时读到的旧副本整体覆盖。
            const latest = (await this.h.ctx.memory.goalStore.loadGoal(goal.goalId)) ?? goal;
            // 成败 = executor 执行结果 AND 契约机械验收（未判定的语义条款不计入失败）。
            const acceptanceOk = outcome.task.acceptanceResult?.passed ?? true;
            latest.status =
                outcome.reason === 'aborted'
                    ? 'aborted'
                    : outcome.ok && acceptanceOk
                      ? 'succeeded'
                      : 'failed';
            await this.h.ctx.memory.goalStore.saveGoal(latest);
            // 契约满足度落事件：Goal.status 是 executor 的成败，这里才是评估器的机械判定，
            // 两者分开（裁决 D8），审计可据此回答「契约到底被满足了没有」。
            const evaluation = rollupAcceptance(
                latest.contract.successConditions.map((condition) => condition.id),
                [outcome.task.acceptanceResult],
            );
            this.h.ctx.observability.bus.emit(
                newHarnessEvent({
                    type: 'goal.contract-evaluated',
                    rootGoalId,
                    goalId: goal.goalId,
                    attributes: { 'harness.level': 'info' },
                    payload: evaluation,
                }),
            );
            await this.h.ctx.observability.bus.flush();
        }
        // 终态失败写入分类账；aborted 是协作式停止、可恢复，不记失败。
        for (const outcome of result.tasks) {
            const acceptanceOk = outcome.task.acceptanceResult?.passed ?? true;
            if ((outcome.ok && acceptanceOk) || outcome.reason === 'aborted') continue;
            await this.h.ctx.memory.failureLedger.add({
                failureId: ulid(),
                sessionId: rootGoalId,
                goalId: outcome.task.goalId,
                taskId: outcome.task.taskId,
                kind: outcome.reason,
                ...(verificationByTask.get(outcome.task.taskId)?.failureCategory !== undefined
                    ? {
                          category: verificationByTask.get(outcome.task.taskId)
                              ?.failureCategory as VerificationFailureCategory,
                      }
                    : {}),
                ...(model !== undefined
                    ? { providerId: model.providerId, modelId: model.modelId }
                    : {}),
                ...(outcome.errorMessage !== undefined ? { summary: outcome.errorMessage } : {}),
                createdAt: Date.now(),
            });
        }
        if (aborted) {
            this.h.ctx.observability.bus.emit(
                newHarnessEvent({
                    type: 'run.aborted',
                    rootGoalId,
                    payload: { reason: 'user-stop' },
                }),
            );
        } else {
            this.h.ctx.observability.bus.emit(
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
        if (blackboardContext !== undefined) {
            const changedPaths = result.tasks.flatMap((outcome) =>
                outcome.steps
                    .filter(
                        (step): step is Extract<Step, { kind: 'invocation' }> =>
                            step.kind === 'invocation' && step.status === 'succeeded',
                    )
                    .flatMap((step) =>
                        typeof step.payload.arguments?.path === 'string'
                            ? [step.payload.arguments.path]
                            : [],
                    ),
            );
            await this.h.ctx.memory.blackboard.updateFromRun(
                blackboardContext.projectId,
                blackboardContext.workspace,
                {
                    rootGoalId,
                    statement: rootGoal?.statement ?? '',
                    ok: result.ok,
                    reason: result.rejected?.join(';') || (result.ok ? 'completed' : 'failed'),
                    ...(result.tasks.at(-1)?.finalMessage !== undefined
                        ? { finalMessage: result.tasks.at(-1)?.finalMessage }
                        : {}),
                    taskTitles: result.tasks.map((outcome) => outcome.task.title),
                    changedPaths: [...new Set(changedPaths)],
                },
            );
        }
        this.h.ctx.session.intake.pendingBlackboard.delete(rootGoalId);
        // project-wiki 的会话后同步由宿主后台队列处理；未挂载时保留 v1 收尾。
        if (this.h.ctx.memory.projectWiki === undefined) {
            await this.h.ctx.memory.wiki.flushRun({
                ...(sessionId !== undefined ? { sessionId } : {}),
                ...(rootGoal?.statement !== undefined && rootGoal.statement.length > 0
                    ? { userRequest: rootGoal.statement }
                    : {}),
            });
        }
        await this.h.ctx.observability.bus.flush();
        return result;
    }

    /**
     * direct 是零执行终态：不创建 Task/Step，也不调用 planner/executor。
     * 直答文本进入 GoalRunResult，供 API 摘要、评估和下一轮会话历史读取。
     */
}

/** GoalRunResult → goal.ended summary（截断 2000 字符） */
function goalRunSummary(result: GoalRunResult): string {
    const last = result.tasks[result.tasks.length - 1];
    if (result.rejected && result.rejected.length > 0) {
        return result.rejected.join(';').slice(0, 2000);
    }
    const summary = result.finalAnswer ?? last?.finalMessage ?? last?.errorMessage;
    return summary && summary.length > 0 ? summary.slice(0, 2000) : '';
}

/** 合并 system prompt 片段：Feature 在前，wiki / blackboard / prompt pack 在后。 */
function combinePromptFragments(
    featureFragment: string | undefined,
    wikiFragment: string | undefined,
    projectWikiFragment: string | undefined,
    blackboardFragment: string | undefined,
    promptPackFragment: string | undefined,
    agentPromptFragment?: string,
): string | undefined {
    const parts = [
        featureFragment?.trim() ?? '',
        wikiFragment?.trim() ?? '',
        projectWikiFragment?.trim() ?? '',
        blackboardFragment?.trim() ?? '',
        promptPackFragment?.trim() ?? '',
        agentPromptFragment?.trim() ?? '',
    ].filter((part) => part.length > 0);
    return parts.length > 0 ? parts.join('\n\n') : undefined;
}

function riskLevelOfGoal(goal: Goal | undefined): PromptRiskLevel {
    if (goal?.contract.riskProfile.hasIrreversibleActions === true) return 'irreversible';
    if (
        goal?.contract.riskProfile.touchesNetwork === true ||
        goal?.contract.riskProfile.touchesExternalApi === true
    ) {
        return 'external';
    }
    if (goal?.permissionCeiling === 'workspace-write' || goal?.permissionCeiling === 'draft') {
        return 'workspace-write';
    }
    return 'read-only';
}
