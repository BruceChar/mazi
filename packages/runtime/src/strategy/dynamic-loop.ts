/**
 * dynamic-loop —— 节点驱动的 Goal 执行（统一编排的落点）。
 *
 * 任务选择、结果收敛、失败归因、完成判定都由 `WorkflowRunner` 的节点与转移表决定。
 * 注入 `GoalRunDeps.orchestration` 后，Router/Plan/Replan/Negotiate 也在同一 runner 上；
 * 未注入时保持旧行为（run 前 plan + think 起手），供历史调用与对照。
 */

import type { ExperimentLoopNode, Goal, Step, Task } from '@mazi/core';
import { ulid } from '@mazi/core';
import {
    type GoalExecutorDeps,
    TaskExecutionContext,
    type TaskOutcome,
} from '../gts/goal-executor.js';
import { planGoalTree } from '../gts/goal-planner.js';
import { type PlanTool, topologicalTaskOrder, validatePlanGraph } from '../gts/plan-graph.js';
import {
    createPlanRevision,
    failureFromOutcome,
    type PlanRevision,
    type ReplanRequest,
} from '../gts/replan.js';
import { verifyTaskOutcome } from '../gts/verification-step.js';
import type { ContextContribution } from '../harness/context-manager.js';
import { type MemoryItem, MemoryManager, turnsToMemory } from '../memory/index.js';
import {
    type ContextView,
    createBuiltinNodes,
    DEFAULT_LIMITS,
    type NodeResult,
    type ObserveFact,
    type PlanTask,
    type WorkflowEvent,
    WorkflowRunner,
    type WorkflowState,
} from '../workflow/index.js';
import type { GoalRunDeps, GoalRunResult } from './goal-strategy.js';

/** 把一次 Task 的工具执行记录成 memory fact，供后续 Task/会话判定“已执行过”。 */
function toolMemoryFacts(steps: readonly Step[], rootGoalId: string): MemoryItem[] {
    return steps
        .filter((step): step is Extract<Step, { kind: 'invocation' }> => step.kind === 'invocation')
        .map((step) => ({
            id: ulid(),
            kind: 'fact' as const,
            text: `已执行工具 ${step.payload.toolName}(${JSON.stringify(step.payload.arguments ?? {})}) → ${(step.payload.output ?? '(no output)').slice(0, 500)}`,
            createdAt: Date.now(),
            rootGoalId,
        }));
}

function minDefined(...values: Array<number | undefined>): number | undefined {
    const defined = values.filter((value): value is number => value !== undefined);
    return defined.length > 0 ? Math.min(...defined) : undefined;
}

function planTasksOf(tasks: readonly Task[]): PlanTask[] {
    return tasks.map((task) => ({
        id: task.taskId,
        title: task.title,
        status:
            task.status === 'succeeded'
                ? ('done' as const)
                : task.status === 'failed'
                  ? ('failed' as const)
                  : ('open' as const),
    }));
}

/** Task 级执行上限：与 default 相同来源（deps > task > contract > goal）。 */
function limitsOf(
    deps: GoalRunDeps,
    task: Task,
    goal: Goal,
): { maxSteps?: number; maxCostUsd?: number } {
    const maxSteps = minDefined(
        deps.maxSteps,
        task.budget?.maxSteps,
        goal.contract.terminationPolicy.maxSteps,
        goal.contract.budget.maxSteps,
        goal.budget.maxSteps,
    );
    const maxCostUsd = minDefined(
        deps.maxCostUsd,
        task.budget?.maxCostUsd,
        goal.contract.budget.maxCostUsd,
        goal.contract.terminationPolicy.maxCostUsd,
        goal.budget.maxCostUsd,
    );
    return {
        ...(maxSteps !== undefined ? { maxSteps } : {}),
        ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    };
}

function taskDeps(
    deps: GoalRunDeps,
    task: Task,
    goal: Goal,
    outcomes: readonly TaskOutcome[],
    contributions: readonly ContextContribution[],
    resumeSteps?: readonly Step[],
): GoalExecutorDeps {
    return {
        store: deps.store,
        requestRound: deps.requestRound,
        ...(deps.systemPrompt !== undefined ? { systemPrompt: deps.systemPrompt } : {}),
        ...(deps.tools !== undefined ? { tools: deps.tools } : {}),
        ...(deps.model !== undefined ? { model: deps.model } : {}),
        ...(deps.invoker !== undefined ? { invoker: deps.invoker } : {}),
        ...(deps.allowedTools !== undefined ? { allowedTools: deps.allowedTools } : {}),
        ...(deps.workspaceRoot !== undefined ? { workspaceRoot: deps.workspaceRoot } : {}),
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
        ...(deps.onStep !== undefined ? { onStep: deps.onStep } : {}),
        ...(resumeSteps !== undefined && resumeSteps.length > 0 ? { resumeSteps } : {}),
        ...limitsOf(deps, task, goal),
        contributions,
        ...(task.dependsOn !== undefined && task.dependsOn.length > 0
            ? {
                  precedingTaskResults: outcomes
                      .filter((item) => task.dependsOn?.includes(item.task.taskId))
                      .map((item) => ({
                          title: item.task.title,
                          ...(item.finalMessage !== undefined
                              ? { finalMessage: item.finalMessage }
                              : {}),
                          ...(item.errorMessage !== undefined
                              ? { errorMessage: item.errorMessage }
                              : {}),
                      })),
              }
            : {}),
    };
}

export interface DynamicLoopInfo {
    mode: 'dynamic';
    outcome: string;
    nodes: number;
    nodeTrail: ExperimentLoopNode[];
}

export async function runGoalTreeDynamic(
    deps: GoalRunDeps,
    goals: readonly Goal[],
): Promise<GoalRunResult> {
    const unified = deps.orchestration !== undefined;
    const resume = deps.resume === true;
    if (resume && !unified) throw new Error('dynamic loop 暂不支持 resume');
    const memory = deps.memory ?? new MemoryManager();
    const rootGoalId = goals[0]?.goalId ?? '';
    const executable = goals.filter(
        (goal) => goal.status === 'active' || (resume && goal.status === 'aborted'),
    );
    const outcomes: TaskOutcome[] = [];
    let tasks: Task[] = [];
    let planDigest: string | undefined;
    const planRevisions: PlanRevision[] = [];

    if (resume) {
        for (const goal of executable) {
            for (const task of await deps.store.listTasks(goal.goalId)) {
                const goalConditions = new Set<string>(
                    goal.contract.successConditions.map((condition) => condition.id),
                );
                if (
                    !task.acceptance.conditions.some((condition) => goalConditions.has(condition))
                ) {
                    task.acceptance.conditions = [...goalConditions];
                    task.permissionCeiling ??= goal.permissionCeiling;
                    task.budget ??= goal.budget;
                    await deps.store.saveTask(task);
                }
                tasks.push(task);
            }
        }
    } else if (!unified && executable.length > 0) {
        const planned = planGoalTree({
            goals: executable,
            ...(deps.planProposal !== undefined ? { proposals: deps.planProposal } : {}),
            ...(deps.planTools !== undefined
                ? { availableTools: deps.planTools as PlanTool[] }
                : {}),
        });
        if (!planned.validation.ok) {
            deps.onPlan?.(0, undefined, planned.rejected ?? ['计划无效']);
            return {
                rootGoalId,
                tasks: [],
                ok: false,
                rejected: planned.rejected ?? ['计划无效'],
            };
        }
        tasks = planned.tasks;
        planDigest = planned.graph?.digest;
        const validation = validatePlanGraph(executable, tasks, deps.planTools);
        if (!validation.ok) {
            deps.onPlan?.(0, undefined, validation.rejected);
            return { rootGoalId, tasks: [], ok: false, rejected: validation.rejected };
        }
        for (const task of tasks) await deps.store.saveTask(task);
        deps.onPlan?.(tasks.length, planDigest, undefined, tasks);
    }
    if (!unified && tasks.length > 0) await deps.onExecutionStart?.();

    let order = topologicalTaskOrder(tasks);
    const goalById = new Map(executable.map((goal) => [goal.goalId, goal]));
    const facts: ObserveFact[] = [];
    const startedAt = Date.now();
    const acceptance = [
        ...new Set(
            executable.flatMap((goal) =>
                goal.contract.successConditions.map((condition) => condition.id),
            ),
        ),
    ];
    let state: WorkflowState = {
        goalId: rootGoalId,
        statement: goals[0]?.statement ?? '',
        phase: unified ? (resume && tasks.length > 0 ? 'think' : 'router') : 'think',
        ...(tasks.length > 0 ? { plan: { version: 1, tasks: planTasksOf(tasks) } } : {}),
        facts,
        pending: [],
        acceptance,
        verdict: 'pending',
        failures: 0,
        actedSincePlan: 0,
        usage: { steps: 0, elapsedMs: 0, tokens: 0, costUsd: 0 },
        startedAt,
    };

    const openOf = (currentState: WorkflowState): Task[] =>
        order.filter(
            (task) =>
                currentState.plan?.tasks.find((item) => item.id === task.taskId)?.status === 'open',
        );

    let current: TaskExecutionContext | undefined;
    let currentContribution: ContextContribution = { id: 'none' };
    let lastOutcome: TaskOutcome | undefined;

    /** Plan/Replan 节点落库后，执行侧从 store 重载 Task 与 Goal（契约可能刚更新）。 */
    const reloadPlan = async (): Promise<void> => {
        const refreshed = await deps.store.listGoalsByRoot(rootGoalId);
        for (const goal of refreshed) goalById.set(goal.goalId, goal);
        tasks = [];
        for (const goal of goalById.values()) {
            tasks.push(...(await deps.store.listTasks(goal.goalId)));
        }
        order = topologicalTaskOrder(tasks);
    };

    const openTask = (currentState: WorkflowState): Task | undefined => {
        for (const task of openOf(currentState)) {
            const depsReady = (task.dependsOn ?? []).every((depId) => {
                const item = currentState.plan?.tasks.find((candidate) => candidate.id === depId);
                return item?.status === 'done';
            });
            if (depsReady) return task;
        }
        return undefined;
    };

    const active = (): TaskExecutionContext => {
        if (current === undefined) throw new Error('dynamic: 当前没有 Task 执行上下文');
        return current;
    };

    const updateTaskPlan = (
        currentState: WorkflowState,
        taskId: string,
        status: 'done' | 'failed',
    ): NonNullable<WorkflowState['plan']> => ({
        version: currentState.plan?.version ?? 1,
        tasks:
            currentState.plan?.tasks.map((item) =>
                item.id === taskId ? { ...item, status } : item,
            ) ?? [],
    });

    const accepted = (outcome: TaskOutcome): boolean =>
        outcome.ok && (outcome.task.acceptanceResult?.passed ?? true);

    const think = async (currentState: WorkflowState): Promise<NodeResult> => {
        if (current === undefined) {
            const task = openTask(currentState);
            if (task === undefined) {
                // 剩余 open 的 Task 依赖失败：全部失败收口，不再空转。
                if (openOf(currentState).length > 0) {
                    return {
                        delta: {
                            plan: {
                                version: currentState.plan?.version ?? 1,
                                tasks:
                                    currentState.plan?.tasks.map((item) =>
                                        item.status === 'open'
                                            ? { ...item, status: 'failed' as const }
                                            : item,
                                    ) ?? [],
                            },
                            failures: currentState.failures + 1,
                        },
                        terminal: 'failed',
                    };
                }
                return { terminal: 'done' as const };
            }
            const goal = goalById.get(task.goalId);
            if (goal === undefined) throw new Error(`Task ${task.taskId} 的 Goal 不在可执行集合`);
            currentContribution = await memory.prepareContribution(
                {
                    rootGoalId,
                    queryText: goal.statement,
                    ...(deps.memoryQuery ?? {}),
                    unionScope: true,
                },
                { id: 'memory' },
            );
            const resumeSteps = resume ? await deps.store.listSteps(task.taskId) : undefined;
            current = new TaskExecutionContext(
                taskDeps(deps, task, goal, outcomes, [currentContribution], resumeSteps),
                task,
                goal,
            );
            await current.start();
            if (current.isTerminal) {
                return { delta: { awaitingVerify: true }, next: 'verify' };
            }
        }
        const result = await active().reason();
        if (result === 'failed') {
            return { delta: { awaitingVerify: true }, next: 'verify' as const };
        }
        if (result === 'final') {
            return { delta: { awaitingVerify: true }, next: 'verify' as const };
        }
        return { next: 'act' as const };
    };

    const act = async (): Promise<NodeResult> => {
        const result = await active().act();
        if (result === 'failed') {
            return { delta: { awaitingVerify: true }, next: 'verify' as const };
        }
        return {
            delta: {
                pending: active().lastOutputs.map((item) => ({
                    callId: item.callId,
                    ok: !item.isError,
                    text: item.output.slice(0, 2000),
                })),
            },
            next: 'observe' as const,
        };
    };

    const observe = async (): Promise<NodeResult> => {
        const result = await active().observe();
        if (result === 'failed') return { next: 'verify' as const };
        if (result === 'final') {
            return { delta: { awaitingVerify: true }, next: 'verify' as const };
        }
        return { next: 'think' as const };
    };

    const verify = async (currentState: WorkflowState): Promise<NodeResult> => {
        const ctx = current;
        if (ctx === undefined) {
            return { delta: { awaitingVerify: false }, next: 'think' as const };
        }
        const task = ctx.task;
        const goal = ctx.goal;
        let outcome: TaskOutcome;
        if (ctx.isTerminal) {
            outcome = ctx.outcome();
        } else {
            await ctx.finishSuccess();
            outcome = ctx.outcome();
        }
        // 验收必须覆盖所有 Task 终态，包括 driver-error / 启动即失败；
        // 否则 timeline 只有 executor 成败，契约判定缺失。
        await verifyTaskOutcome({
            goal,
            outcome,
            store: deps.store,
            ...(deps.verifier !== undefined ? { verifier: deps.verifier } : {}),
            ...(deps.onVerification !== undefined ? { onVerification: deps.onVerification } : {}),
            ...(deps.onStep !== undefined ? { onStep: deps.onStep } : {}),
        });
        if (outcome.ok && outcome.task.acceptanceResult?.passed === false) {
            outcome.task.status = 'failed';
        }
        await ctx.applyAcceptance(outcome.task.status);
        outcomes.push(outcome);
        lastOutcome = outcome;
        current = undefined;
        const items: MemoryItem[] = turnsToMemory(
            [
                { role: 'user', text: goal.statement },
                { role: 'assistant', text: outcome.finalMessage ?? '' },
            ],
            {
                rootGoalId,
                ...(deps.memoryWriteContext ?? {}),
                provenance: { source: 'system', confidence: 'confirmed', trustTier: 'T2' },
            },
        );
        items.push(...toolMemoryFacts(outcome.steps, rootGoalId));
        await memory.remember(items);
        const taskOk = accepted(outcome);
        const nextPlan = updateTaskPlan(currentState, task.taskId, taskOk ? 'done' : 'failed');
        const remaining = nextPlan.tasks.some((item) => item.status === 'open');
        const allOk = [...outcomes].every(accepted);
        const replanIneligible = new Set(['aborted', 'budget-exceeded', 'max-steps', 'timeout']);
        const shouldReplan =
            !taskOk &&
            deps.orchestration?.replan !== undefined &&
            !replanIneligible.has(outcome.reason) &&
            planRevisions.length < (deps.replan?.maxReplans ?? 2);
        if (shouldReplan) {
            return {
                delta: {
                    plan: nextPlan,
                    awaitingVerify: false,
                    failures: currentState.failures + 1,
                    verdict: 'failed',
                    replanRequested: true,
                },
                next: 'replan' as const,
            };
        }
        if (!remaining) {
            return {
                delta: {
                    plan: nextPlan,
                    awaitingVerify: false,
                    failures: currentState.failures + (taskOk ? 0 : 1),
                    ...(allOk ? { verdict: 'passed' as const } : { verdict: 'failed' as const }),
                },
                terminal: allOk ? ('done' as const) : ('done-unverified' as const),
            };
        }
        return {
            delta: {
                plan: nextPlan,
                awaitingVerify: false,
                failures: currentState.failures + (taskOk ? 0 : 1),
                ...(taskOk ? {} : { verdict: 'failed' as const }),
            },
            next: 'think' as const,
        };
    };

    const replan = async (): Promise<NodeResult> => {
        const outcome = lastOutcome;
        if (outcome === undefined || deps.replan === undefined) {
            return { delta: { replanRequested: false }, terminal: 'failed' };
        }
        const goal = goalById.get(outcome.task.goalId);
        if (goal === undefined) {
            return { delta: { replanRequested: false }, terminal: 'failed' };
        }
        const failure = failureFromOutcome(outcome);
        const executedTaskIds = new Set(outcomes.map((item) => item.task.taskId));
        const remainingTasks = tasks.filter(
            (candidate) =>
                candidate.taskId !== outcome.task.taskId &&
                !executedTaskIds.has(candidate.taskId) &&
                (candidate.status === 'pending' || candidate.status === 'active'),
        );
        const request: ReplanRequest = {
            goal,
            revision: planRevisions.length,
            completedTasks: outcomes
                .slice(0, -1)
                .filter(
                    (candidate) =>
                        candidate.ok && (candidate.task.acceptanceResult?.passed ?? true),
                )
                .map((candidate) => candidate.task),
            failedTask: outcome.task,
            remainingTasks,
            failureReason: failure.failureReason,
            ...(failure.failureCategory !== undefined
                ? { failureCategory: failure.failureCategory }
                : {}),
            evidence: failure.evidence,
            remainingBudget: goal.budget,
            ...(deps.replan.availableTools !== undefined
                ? { availableTools: deps.replan.availableTools }
                : {}),
        };
        try {
            const proposal = await deps.replan.planner(request);
            if (proposal === undefined) {
                deps.onReplan?.(undefined, ['ReplanPlanner 未返回计划'], []);
                return { delta: { replanRequested: false }, terminal: 'done-unverified' };
            }
            const revised = await createPlanRevision({
                request,
                proposal,
                ...(deps.replan.availableTools !== undefined
                    ? { availableTools: deps.replan.availableTools }
                    : {}),
                priorDigests: planRevisions.map((revision) => revision.digest),
            });
            if (revised.revision === undefined) {
                deps.onReplan?.(undefined, revised.rejected ?? [], revised.warnings ?? []);
                return { delta: { replanRequested: false }, terminal: 'done-unverified' };
            }
            const revision = revised.revision;
            planRevisions.push(revision);
            deps.onReplan?.(revision, undefined, revision.warnings ?? []);
            for (const task of revision.tasks) await deps.store.saveTask(task);
            await reloadPlan();
            return {
                delta: {
                    plan: { version: revision.planVersion, tasks: planTasksOf(tasks) },
                    replanRequested: false,
                    actedSincePlan: 0,
                },
                next: 'think',
            };
        } catch (error) {
            deps.onReplan?.(
                undefined,
                [error instanceof Error ? error.message : String(error)],
                [],
            );
            return { delta: { replanRequested: false }, terminal: 'done-unverified' };
        }
    };

    const orchestration = deps.orchestration;
    const planNode = async (
        currentState: WorkflowState,
        view: ContextView,
    ): Promise<NodeResult> => {
        if (orchestration === undefined) return { terminal: 'failed' };
        const result = await orchestration.plan(currentState, view);
        if (result.next === 'think' || result.next === 'act' || result.next === 'verify') {
            await reloadPlan();
            if (tasks.length > 0) await deps.onExecutionStart?.();
        }
        return {
            ...result,
            delta: {
                ...result.delta,
                ...(tasks.length > 0
                    ? {
                          plan: {
                              version: currentState.plan?.version ?? 1,
                              tasks: planTasksOf(tasks),
                          },
                      }
                    : {}),
            },
        };
    };

    const nodes = createBuiltinNodes(
        {
            think,
            act,
            observe,
            verify,
            ...(orchestration !== undefined
                ? {
                      router: orchestration.router,
                      plan: planNode,
                      negotiate: orchestration.negotiate,
                      replan: orchestration.replan ?? replan,
                  }
                : {}),
        },
        { ...DEFAULT_LIMITS, maxNoProgress: 6 },
    );
    const runner = new WorkflowRunner(
        nodes,
        {
            base: '',
            byRole: {
                router: '',
                plan: '',
                negotiate: '',
                think: '',
                act: '',
                observe: '',
                verify: '',
                replan: '',
                reflect: '',
            },
        },
        { ...DEFAULT_LIMITS, maxNoProgress: 6 },
        Date.now,
        deps.onWorkflowNode,
    );
    const run = await runner.run(state);
    state = run.state;
    facts.push(...run.state.facts.slice(facts.length));

    const acceptedRun = run.outcome === 'done' || run.outcome === 'done-unverified';
    if (!acceptedRun && current !== undefined && !current.isTerminal) {
        const reason =
            run.outcome === 'aborted-budget' || run.outcome === 'aborted-no-progress'
                ? 'max-steps'
                : run.outcome === 'failed'
                  ? 'driver-error'
                  : 'aborted';
        await current.finalizeFailure(reason, `workflow 提前终止（${run.outcome}），未完成验收`);
        outcomes.push(current.outcome());
    }
    const ok = outcomes.every(accepted);
    const nodeTrail: ExperimentLoopNode[] = run.events.map((event: WorkflowEvent) => ({
        kind:
            event.type === 'node.selected'
                ? ('selected' as const)
                : event.type === 'node.failed'
                  ? ('failed' as const)
                  : ('terminated' as const),
        ...(event.role !== undefined ? { role: event.role } : {}),
        ...(event.nodeId !== undefined ? { nodeId: event.nodeId } : {}),
        reason: event.reason,
        at: event.at,
    }));
    const loop: DynamicLoopInfo = {
        mode: 'dynamic',
        outcome: run.outcome,
        nodes: nodeTrail.filter((node) => node.kind === 'selected').length,
        nodeTrail,
    };
    return {
        rootGoalId,
        tasks: outcomes,
        ok: ok && acceptedRun,
        ...(run.state.finalAnswer !== undefined ? { finalAnswer: run.state.finalAnswer } : {}),
        ...(run.outcome === 'awaiting-negotiation' ? { awaitingNegotiation: true } : {}),
        ...(acceptedRun ? {} : { rejected: [run.outcome] }),
        ...(planRevisions.length > 0 ? { planRevisions } : {}),
        loop,
    };
}
