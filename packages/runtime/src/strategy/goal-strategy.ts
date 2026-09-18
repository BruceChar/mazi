/**
 * goal-strategy —— Goal 顺序驱动（C3d）。
 * planGoalTree → 逐 Goal 的 Task 顺序执行（executeTask）。执行事实全部经 GoalStore 留痕。
 *
 * 跨 Goal 的共享上下文由 MemoryManager 调度：每个 Goal 开始前按策略召回并转成
 * ContextContribution，结束后把本 Goal 的轮次写回长期记忆；memory 缺省时内部新建
 * 一个进程内 MemoryManager，测试可直接注入。
 */

import { type Goal, type Step, ulid } from '@mazi/core';
import type { GoalExecutorDeps, GoalToolInvoker, TaskOutcome } from '../gts/goal-executor.js';
import { executeTask } from '../gts/goal-executor.js';
import { planGoalTree } from '../gts/goal-planner.js';
import type { ContextContribution } from '../harness/context-manager.js';
import type { GoalStore } from '../memory/goal-store.js';
import { type MemoryItem, MemoryManager, turnsToMemory } from '../memory/index.js';

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
    /** 工作目录（透传 executeTask；入库到 invocation payload.cwd） */
    workspaceRoot?: string;
    /** Step 流式回调（透传 executeTask.onStep） */
    onStep?: GoalExecutorDeps['onStep'];
}

export interface GoalRunResult {
    rootGoalId: string;
    tasks: TaskOutcome[];
    ok: boolean;
    rejected?: string[];
}

export async function runGoalTree(deps: GoalRunDeps, goals: Goal[]): Promise<GoalRunResult> {
    const memory = deps.memory ?? new MemoryManager();
    const runId = goals[0]?.goalId ?? '';
    const plan = planGoalTree({ goals });
    const outcomes: TaskOutcome[] = [];
    for (const goal of plan.goals) {
        const task = plan.tasks.find((t) => t.goalId === goal.goalId);
        if (task === undefined) continue;
        const contribution: ContextContribution = await memory.prepareContribution(
            { rootGoalId: runId },
            { id: 'memory' },
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
                contributions: [contribution],
                ...(deps.onStep !== undefined ? { onStep: deps.onStep } : {}),
            },
            task,
            goal,
        );
        outcomes.push(outcome);
        if (!outcome.ok) break; // 顺序依赖：首个失败即停（后续可扩展为任务组并行）
        // Task 之间共享上下文：本 Goal 的输入、最终回答与工具执行事实写入长期记忆，供后续 Goal/会话召回
        const items: MemoryItem[] = turnsToMemory(
            [
                { role: 'user', text: goal.statement },
                { role: 'assistant', text: outcome.finalMessage ?? '' },
            ],
            { rootGoalId: runId },
        );
        items.push(...toolMemoryFacts(outcome.steps, runId));
        await memory.remember(items);
    }
    return {
        rootGoalId: runId,
        tasks: outcomes,
        ok: outcomes.every((o) => o.ok),
    };
}
