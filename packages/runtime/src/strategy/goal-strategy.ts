/**
 * goal-strategy —— Goal 顺序驱动（C3d）。
 * planGoalTree → 逐 Goal 的 Task 顺序执行（executeTask）。执行事实全部经 GoalStore 留痕。
 *
 * 跨 Goal 的共享上下文由 MemoryManager 调度：每个 Goal 开始前按策略召回并转成
 * ContextContribution，结束后把本 Goal 的轮次写回长期记忆；memory 缺省时内部新建
 * 一个进程内 MemoryManager，测试可直接注入。
 */

import { type Goal, type Step, type Task, ulid } from '@mazi/core';
import { evaluateAcceptance } from '../gts/acceptance.js';
import type { GoalExecutorDeps, GoalToolInvoker, TaskOutcome } from '../gts/goal-executor.js';
import { executeTask } from '../gts/goal-executor.js';
import { planGoalTree } from '../gts/goal-planner.js';
import {
    type PlannedTask,
    type PlanTool,
    topologicalTaskOrder,
    validatePlanGraph,
} from '../gts/plan-graph.js';
import {
    createPlanRevision,
    failureFromOutcome,
    type PlanRevision,
    type ReplanOption,
    type ReplanRequest,
} from '../gts/replan.js';
import type { ContextContribution } from '../harness/context-manager.js';
import type { GoalStore } from '../memory/goal-store.js';
import {
    type MemoryItem,
    MemoryManager,
    type MemoryQuery,
    turnsToMemory,
} from '../memory/index.js';
import type { TaskVerifier, VerificationReport } from '../verifier/index.js';

/** 把一次 Task 的工具执行记录成 memory fact，供后续 Goal/会话判定“已执行过”。 */
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

export interface GoalRunDeps {
    store: GoalStore;
    requestRound: GoalExecutorDeps['requestRound'];
    systemPrompt?: string;
    tools?: GoalExecutorDeps['tools'];
    model?: GoalExecutorDeps['model'];
    /** 工具执行器；未装配时 executeTask 拒绝一切 toolCall */
    invoker?: GoalToolInvoker;
    /** Task 允许的工具白名单（undefined = 不限） */
    allowedTools?: string[];
    /** 记忆调度组合根（缺省新建进程内实现）。 */
    memory?: MemoryManager;
    /** Scoped recall selector; unionScope joins user/workspace/session/task views. */
    memoryQuery?: MemoryQuery;
    /** Scope written back for this run's episodic memory. */
    memoryWriteContext?: {
        conversationId?: string;
        userId?: string;
        workspaceId?: string;
        projectId?: string;
    };
    /** 工作目录（透传 executeTask；入库到 invocation payload.cwd） */
    workspaceRoot?: string;
    /** Step 流式回调（透传 executeTask.onStep） */
    onStep?: GoalExecutorDeps['onStep'];
    /** 协作式停止信号（透传 executeTask）。 */
    signal?: AbortSignal;
    /** Optional hierarchical plan proposal from the model/caller. */
    planProposal?: readonly PlannedTask[];
    /** Available tool catalogue used by plan preflight. */
    planTools?: readonly PlanTool[];
    /** Plan lifecycle observation for auditing/UI. */
    onPlan?: (
        taskCount: number,
        digest?: string,
        rejected?: readonly string[],
        tasks?: readonly Task[],
    ) => void;
    /** Independent verifier; absence keeps mechanical acceptance for lightweight callers. */
    verifier?: TaskVerifier;
    onVerification?: (report: VerificationReport, outcome: TaskOutcome) => void;
    /** Bounded dynamic replanning after verifier/executor failure. */
    replan?: ReplanOption;
    onReplan?: (revision?: PlanRevision, rejected?: readonly string[]) => void;
    /** 恢复模式：复用未终结 Task 并从已落库 Step 重放上下文。 */
    resume?: boolean;
    /** 轮次上限覆盖（缺省读 goal.contract.terminationPolicy.maxSteps）。 */
    maxSteps?: number;
    /** 成本上限覆盖 USD（缺省读 goal.contract.budget.maxCostUsd）。 */
    maxCostUsd?: number;
}

export interface GoalRunResult {
    rootGoalId: string;
    tasks: TaskOutcome[];
    ok: boolean;
    rejected?: string[];
    planRevisions?: PlanRevision[];
}

function minDefined(...values: Array<number | undefined>): number | undefined {
    const defined = values.filter((value): value is number => value !== undefined);
    return defined.length > 0 ? Math.min(...defined) : undefined;
}

export async function runGoalTree(deps: GoalRunDeps, goals: Goal[]): Promise<GoalRunResult> {
    const memory = deps.memory ?? new MemoryManager();
    const runId = goals[0]?.goalId ?? '';
    const resume = deps.resume === true;
    const executable = goals.filter(
        (goal) => goal.status === 'active' || (resume && goal.status === 'aborted'),
    );
    const outcomes: TaskOutcome[] = [];
    let tasks: Task[];
    let planDigest: string | undefined;
    if (resume) {
        tasks = [];
        for (const goal of executable) {
            for (const task of await deps.store.listTasks(goal.goalId)) {
                const goalConditions = new Set<string>(
                    goal.contract.successConditions.map((condition) => condition.id),
                );
                if (
                    !task.acceptance.conditions.some((condition) => goalConditions.has(condition))
                ) {
                    // Legacy rows predate Task-level acceptance and may contain placeholders.
                    task.acceptance.conditions = [...goalConditions];
                    task.permissionCeiling ??= goal.permissionCeiling;
                    task.budget ??= goal.budget;
                    await deps.store.saveTask(task);
                }
                tasks.push(task);
            }
        }
        if (tasks.length === 0) {
            const planGoals = executable.map((goal) =>
                goal.status === 'aborted' ? { ...goal, status: 'active' as const } : goal,
            );
            const planned = planGoalTree({
                goals: planGoals,
                ...(deps.planProposal !== undefined ? { proposals: deps.planProposal } : {}),
                ...(deps.planTools !== undefined ? { availableTools: deps.planTools } : {}),
            });
            if (!planned.validation.ok) {
                deps.onPlan?.(0, undefined, planned.rejected ?? ['计划无效']);
                return {
                    rootGoalId: runId,
                    tasks: [],
                    ok: false,
                    rejected: planned.rejected ?? ['计划无效'],
                };
            }
            tasks = planned.tasks;
            planDigest = planned.graph?.digest;
        }
        const validation = validatePlanGraph(executable, tasks, deps.planTools);
        if (!validation.ok) {
            deps.onPlan?.(0, undefined, validation.rejected);
            return { rootGoalId: runId, tasks: [], ok: false, rejected: validation.rejected };
        }
    } else {
        const planned = planGoalTree({
            goals: executable,
            ...(deps.planProposal !== undefined ? { proposals: deps.planProposal } : {}),
            ...(deps.planTools !== undefined ? { availableTools: deps.planTools } : {}),
        });
        if (!planned.validation.ok) {
            deps.onPlan?.(0, undefined, planned.rejected ?? ['计划无效']);
            return {
                rootGoalId: runId,
                tasks: [],
                ok: false,
                rejected: planned.rejected ?? ['计划无效'],
            };
        }
        tasks = planned.tasks;
        planDigest = planned.graph?.digest;
    }
    deps.onPlan?.(tasks.length, planDigest, undefined, tasks);
    const goalById = new Map(executable.map((goal) => [goal.goalId, goal]));
    let queue = topologicalTaskOrder(tasks);
    let cursor = 0;
    const planRevisions: PlanRevision[] = [];
    while (cursor < queue.length) {
        const task = queue[cursor];
        cursor += 1;
        if (task === undefined || task.status === 'succeeded') continue;
        const goal = goalById.get(task.goalId);
        if (goal === undefined) {
            return {
                rootGoalId: runId,
                tasks: outcomes,
                ok: false,
                rejected: [`Task ${task.taskId} 的 Goal 不在可执行集合`],
            };
        }
        const contribution: ContextContribution = await memory.prepareContribution(
            {
                rootGoalId: runId,
                queryText: goal.statement,
                ...(deps.memoryQuery ?? {}),
                unionScope: true,
            },
            { id: 'memory' },
        );
        const resumeSteps = resume ? await deps.store.listSteps(task.taskId) : undefined;
        // 契约 → 执行上限：终止策略与预算来自 Goal 冻结契约；运行级 deps 显式覆盖
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
        const outcome = await executeTask(
            {
                store: deps.store,
                requestRound: deps.requestRound,
                ...(deps.systemPrompt !== undefined ? { systemPrompt: deps.systemPrompt } : {}),
                ...(deps.tools !== undefined ? { tools: deps.tools } : {}),
                ...(deps.model !== undefined ? { model: deps.model } : {}),
                ...(deps.invoker !== undefined ? { invoker: deps.invoker } : {}),
                ...(deps.allowedTools !== undefined ? { allowedTools: deps.allowedTools } : {}),
                ...(deps.workspaceRoot !== undefined ? { workspaceRoot: deps.workspaceRoot } : {}),
                ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
                ...(resumeSteps !== undefined && resumeSteps.length > 0 ? { resumeSteps } : {}),
                contributions: [contribution],
                ...(deps.onStep !== undefined ? { onStep: deps.onStep } : {}),
                ...(maxSteps !== undefined ? { maxSteps } : {}),
                ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
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
            },
            task,
            goal,
        );
        // 验收判定：评估器独立于 executor 产出事实并随 Task 落库（裁决 D8）
        let verificationReport: VerificationReport | undefined;
        if (deps.verifier !== undefined) {
            const report = await deps.verifier.verify(goal, outcome);
            verificationReport = report;
            outcome.task.acceptanceResult = report.acceptance;
            deps.onVerification?.(report, outcome);
        } else {
            outcome.task.acceptanceResult = evaluateAcceptance(goal, outcome);
        }
        await deps.store.saveTask(outcome.task);
        outcomes.push(outcome);
        const shouldReplan = !outcome.ok || verificationReport?.state === 'failed';
        if (shouldReplan) {
            const maxReplans = deps.replan?.maxReplans ?? 2;
            if (deps.replan === undefined || planRevisions.length >= maxReplans) break;
            const failure = failureFromOutcome(outcome, verificationReport);
            const request: ReplanRequest = {
                goal,
                revision: planRevisions.length,
                completedTasks: outcomes
                    .slice(0, -1)
                    .filter((candidate) => candidate.ok)
                    .map((candidate) => candidate.task),
                failedTask: outcome.task,
                failureReason: failure.failureReason,
                ...(failure.failureCategory !== undefined
                    ? { failureCategory: failure.failureCategory }
                    : {}),
                evidence: failure.evidence,
                remainingBudget: goal.budget,
            };
            try {
                const proposal = await deps.replan.planner(request);
                if (proposal === undefined) {
                    deps.onReplan?.(undefined, ['ReplanPlanner 未返回计划']);
                    break;
                }
                const revised = await createPlanRevision({
                    request,
                    proposal,
                    ...(deps.replan.availableTools !== undefined
                        ? { availableTools: deps.replan.availableTools }
                        : {}),
                    priorDigests: [
                        ...(planDigest !== undefined ? [planDigest] : []),
                        ...planRevisions.map((revision) => revision.digest),
                    ],
                });
                if (revised.revision === undefined) {
                    deps.onReplan?.(undefined, revised.rejected ?? ['Replan 被拒绝']);
                    break;
                }
                outcomes.pop();
                tasks = revised.revision.tasks;
                for (const nextTask of tasks) {
                    if (nextTask.status !== 'succeeded') await deps.store.saveTask(nextTask);
                }
                planRevisions.push(revised.revision);
                deps.onReplan?.(revised.revision);
                queue = topologicalTaskOrder(tasks);
                cursor = 0;
                continue;
            } catch (error) {
                deps.onReplan?.(undefined, [
                    error instanceof Error ? error.message : String(error),
                ]);
                break;
            }
        }
        // Task 之间共享上下文：本 Goal 的输入、最终回答与工具执行事实写入长期记忆，供后续 Goal/会话召回
        const items: MemoryItem[] = turnsToMemory(
            [
                { role: 'user', text: goal.statement },
                { role: 'assistant', text: outcome.finalMessage ?? '' },
            ],
            {
                rootGoalId: runId,
                ...(deps.memoryWriteContext ?? {}),
                provenance: { source: 'system', confidence: 'confirmed', trustTier: 'T2' },
            },
        );
        items.push(...toolMemoryFacts(outcome.steps, runId));
        await memory.remember(items);
    }
    return {
        rootGoalId: runId,
        tasks: outcomes,
        ok: outcomes.every((o) => o.ok),
        ...(planRevisions.length > 0 ? { planRevisions } : {}),
    };
}
