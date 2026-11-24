/**
 * dynamic-loop —— 节点驱动的 Goal 执行（loopMode='dynamic'）。
 *
 * 与 default（goal-strategy 的串行 cursor）的区别：任务选择、结果收敛、
 * 失败归因、完成判定都由 WorkflowRunner 的节点与转移表决定，而不是 while+cursor。
 *
 * v1 边界：不支持 resume；不做跨 Task 的 Replan；不做 memory 召回（沿用
 * executeTask 的 Task 内记忆）。这三项在 switch 前必须补齐或明确降级。
 */

import type { ExperimentLoopNode, Goal, Task } from '@mazi/core';
import { evaluateAcceptance } from '../gts/acceptance.js';
import {
    type GoalExecutorDeps,
    TaskExecutionContext,
    type TaskOutcome,
} from '../gts/goal-executor.js';
import { planGoalTree } from '../gts/goal-planner.js';
import { type PlanTool, topologicalTaskOrder, validatePlanGraph } from '../gts/plan-graph.js';
import type { ContextContribution } from '../harness/context-manager.js';
import type { VerificationReport } from '../verifier/index.js';
import {
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
    if (deps.resume === true) throw new Error('dynamic loop 暂不支持 resume');
    const rootGoalId = goals[0]?.goalId ?? '';
    const executable = goals.filter((goal) => goal.status === 'active');
    const outcomes: TaskOutcome[] = [];
    let tasks: Task[] = [];
    let planDigest: string | undefined;

    if (executable.length > 0) {
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
    if (tasks.length > 0) await deps.onExecutionStart?.();

    const order = topologicalTaskOrder(tasks);
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
        phase: 'think',
        plan: { version: 1, tasks: planTasksOf(tasks) },
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
            current = new TaskExecutionContext(
                taskDeps(deps, task, goal, outcomes, [{ id: 'none' }]),
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
            if (deps.verifier !== undefined) {
                const report: VerificationReport = await deps.verifier.verify(goal, outcome);
                outcome.task.acceptanceResult = report.acceptance;
                deps.onVerification?.(report, outcome);
            } else {
                outcome.task.acceptanceResult = evaluateAcceptance(goal, outcome);
            }
            if (outcome.ok && outcome.task.acceptanceResult?.passed === false) {
                outcome.task.status = 'failed';
            }
            await ctx.applyAcceptance(outcome.task.status);
        }
        outcomes.push(outcome);
        current = undefined;
        const taskOk = accepted(outcome);
        const nextPlan = updateTaskPlan(currentState, task.taskId, taskOk ? 'done' : 'failed');
        const remaining = nextPlan.tasks.some((item) => item.status === 'open');
        const allOk = [...outcomes].every(accepted);
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

    const nodes = createBuiltinNodes(
        {
            think,
            act,
            observe,
            verify,
        },
        { ...DEFAULT_LIMITS, maxNoProgress: 6 },
    );
    const runner = new WorkflowRunner(
        nodes,
        {
            base: '',
            byRole: { think: '', act: '', observe: '', plan: '', verify: '', reflect: '' },
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
        ...(acceptedRun ? {} : { rejected: [run.outcome] }),
        loop,
    };
}
