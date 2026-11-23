/**
 * dynamic-loop —— 节点驱动的 Goal 执行（loopMode='dynamic'）。
 *
 * 与 default（goal-strategy 的串行 cursor）的区别：任务选择、结果收敛、
 * 失败归因、完成判定都由 WorkflowRunner 的节点与转移表决定，而不是 while+cursor。
 *
 * v1 边界：不支持 resume；不做跨 Task 的 Replan；不做 memory 召回（沿用
 * executeTask 的 Task 内记忆）。这三项在 switch 前必须补齐或明确降级。
 */

import type { Goal, Task } from '@mazi/core';
import { evaluateAcceptance } from '../gts/acceptance.js';
import { executeTask, type TaskOutcome } from '../gts/goal-executor.js';
import { planGoalTree } from '../gts/goal-planner.js';
import { type PlanTool, topologicalTaskOrder, validatePlanGraph } from '../gts/plan-graph.js';
import type { ContextContribution } from '../harness/context-manager.js';
import type { VerificationReport } from '../verifier/index.js';
import {
    type ActRawResult,
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
): Parameters<typeof executeTask>[0] {
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
    let current: Task | undefined;
    const startedAt = Date.now();
    const verifications = new Map<string, VerificationReport>();
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

    /** Think：选择下一个可执行 Task（拓扑序 + 依赖已成功）。 */
    const think = async (currentState: WorkflowState): Promise<NodeResult> => {
        current = undefined;
        for (const task of openOf(currentState)) {
            const depsReady = (task.dependsOn ?? []).every((depId) => {
                const item = currentState.plan?.tasks.find((candidate) => candidate.id === depId);
                return item?.status === 'done';
            });
            if (!depsReady) continue;
            current = task;
            return { next: 'act' };
        }
        // 没有可执行 Task（依赖失败）：把所有剩余 open 标 failed，交给 runner 收尾。
        const remaining = openOf(currentState);
        if (remaining.length === 0) return { next: 'act' };
        return {
            delta: {
                plan: {
                    version: currentState.plan?.version ?? 1,
                    tasks:
                        currentState.plan?.tasks.map((item) =>
                            item.status === 'open' ? { ...item, status: 'failed' as const } : item,
                        ) ?? [],
                },
                failures: currentState.failures + 1,
            },
            next: 'act',
        };
    };

    /** Act：执行当前 Task（含独立验收），把结果收敛为 pending 交给 Observe。 */
    const act = async (currentState: WorkflowState): Promise<NodeResult> => {
        const task = current;
        current = undefined;
        if (task === undefined) {
            return { delta: { pending: [] }, next: 'observe' };
        }
        const goal = goalById.get(task.goalId);
        if (goal === undefined) throw new Error(`Task ${task.taskId} 的 Goal 不在可执行集合`);
        const contribution: ContextContribution = { id: 'none' };
        const outcome = await executeTask(
            taskDeps(deps, task, goal, outcomes, [contribution]),
            task,
            goal,
        );
        let report: VerificationReport | undefined;
        if (deps.verifier !== undefined) {
            report = await deps.verifier.verify(goal, outcome);
            outcome.task.acceptanceResult = report.acceptance;
            verifications.set(task.taskId, report);
            deps.onVerification?.(report, outcome);
        } else {
            outcome.task.acceptanceResult = evaluateAcceptance(goal, outcome);
        }
        if (outcome.ok && outcome.task.acceptanceResult?.passed === false) {
            outcome.task.status = 'failed';
        }
        await deps.store.saveTask(outcome.task);
        outcomes.push(outcome);

        const passed = outcome.ok && (outcome.task.acceptanceResult?.passed ?? true);
        const planStatus = passed ? ('done' as const) : ('failed' as const);
        const raw: ActRawResult = {
            callId: task.taskId,
            ok: passed,
            text: (outcome.finalMessage ?? outcome.errorMessage ?? outcome.reason).slice(0, 2000),
        };
        return {
            delta: {
                plan: {
                    version: currentState.plan?.version ?? 1,
                    tasks:
                        currentState.plan?.tasks.map((item) =>
                            item.id === task.taskId ? { ...item, status: planStatus } : item,
                        ) ?? [],
                },
                pending: [raw],
                failures: currentState.failures + (passed ? 0 : 1),
                actedSincePlan: currentState.actedSincePlan + 1,
                ...(passed ? {} : { verdict: 'failed' as const }),
            },
            next: 'observe',
        };
    };

    const nodes = createBuiltinNodes(
        { think: (currentState) => think(currentState), act: (currentState) => act(currentState) },
        DEFAULT_LIMITS,
    );
    const runner = new WorkflowRunner(
        nodes,
        {
            base: '',
            byRole: { think: '', act: '', observe: '', plan: '', verify: '', reflect: '' },
        },
        { ...DEFAULT_LIMITS, maxNoProgress: 6 },
    );
    const run = await runner.run(state);
    state = run.state;
    facts.push(...run.state.facts.slice(facts.length));

    const ok = outcomes.every((item) => item.ok && (item.task.acceptanceResult?.passed ?? true));
    const accepted = run.outcome === 'done' || run.outcome === 'done-unverified';
    const loop: DynamicLoopInfo = {
        mode: 'dynamic',
        outcome: run.outcome,
        nodes: run.events.filter((event: WorkflowEvent) => event.type === 'node.selected').length,
    };
    return {
        rootGoalId,
        tasks: outcomes,
        ok: ok && accepted,
        ...(accepted ? {} : { rejected: [run.outcome] }),
        loop,
    };
}
