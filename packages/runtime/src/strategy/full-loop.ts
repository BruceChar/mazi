import type {
    Capacity,
    GoalContract,
    HarnessStrategy,
    LoopMode,
    StrategyCapabilities,
    StrategyContext,
    StrategyEvent,
    Turn,
    TurnContract,
} from '@mazi/core';
import { ulid } from '@mazi/core';
import type { Executor, TurnExecutionOutcome } from '../executor/index.js';
import { newHarnessEvent } from '../observability/index.js';
import { MechanicalReflector } from './reflector.js';

/** 默认 Loop 模式：Goal → Plan → Execute → Reflect */
export const DEFAULT_LOOP_MODE: LoopMode = 'goal-plan-execute-reflect';

/** 内置 Loop 模式（docs/总体设计文档v1.3.md §3.1.1） */
export const LOOP_MODES: readonly LoopMode[] = [
    'goal-plan-execute-reflect',
    'goal-plan-execute',
    'react-only',
];

const CAPABILITIES: StrategyCapabilities = {
    needsGoal: true,
    needsPlan: true,
    needsExecute: true,
    needsObserve: true,
    needsReflect: true,
    needsPersistentState: true,
};

/** 非法/缺省模式回退到 GPER，保证旧 Session 行为不变 */
function normalizeLoopMode(value: LoopMode | string | undefined): LoopMode {
    return LOOP_MODES.includes(value as LoopMode) ? (value as LoopMode) : DEFAULT_LOOP_MODE;
}

function defaultFailureSignals(): TurnContract['failureSignals'] {
    return [
        { kind: 'tool-error', action: 'retry', maxRetries: 1 },
        { kind: 'budget-exceeded', action: 'abort-turn' },
        { kind: 'acceptance-failed', action: 'abort-turn' },
    ];
}

/**
 * Full-Loop 策略（feature F12，Loop 模式 v0.1）：
 * - goal-plan-execute-reflect（默认）：Planner.plan → Executor → Reflector 机械验收；
 * - goal-plan-execute：跳过 Reflector，执行成功即接受；
 * - react-only：跳过 Planner.plan，用 Goal 直接构建单 Turn Think-Act-Observe。
 */
export class FullLoopStrategy implements HarnessStrategy {
    readonly id = 'full-loop';
    readonly version = '0.2.0';
    readonly capabilities = CAPABILITIES;

    score(): number {
        return 1;
    }

    async *run(ctx: StrategyContext): AsyncIterable<StrategyEvent> {
        const session = ctx.session;
        const goal = session.goal;
        const loopMode = normalizeLoopMode(goal.loopMode);
        ctx.emit(
            newHarnessEvent({
                type: 'strategy.selected',
                sessionId: session.sessionId,
                attributes: {
                    'harness.strategy_id': this.id,
                    'harness.loop_mode': loopMode,
                },
                payload: { strategyId: this.id, version: this.version, mode: loopMode },
            }),
        );
        const planner = ctx.planner;
        const executor = ctx.executor as Executor | undefined;
        if (!planner || !executor) {
            throw new Error('full-loop 需要 planner 与 executor 已注入');
        }
        if (loopMode === 'react-only') {
            await this.executeTurn(ctx, this.reactOnlyContract(goal), false);
            yield* [];
            return;
        }
        const planResult = await planner.plan(goal);
        const contracts = normalizeContracts(planResult);
        const reflect = loopMode === 'goal-plan-execute-reflect';
        for (const contract of contracts) {
            await this.executeTurn(ctx, contract, reflect);
        }
        // 生成器契约：事件已通过 ctx.emit 送达总线；此处仅确保迭代完成时提供空流
        yield* [];
    }

    /** react-only：不做 Plan 分解，按 Goal 直接生成单 Turn 契约 */
    private reactOnlyContract(goal: GoalContract): TurnContract {
        const requiredTools =
            (goal.metadata?.requiredTools as TurnContract['requiredTools'] | undefined) ?? [];
        const tooling =
            requiredTools.length > 0 ||
            goal.allowedTools === 'all-registry' ||
            (Array.isArray(goal.allowedTools) && goal.allowedTools.length > 0);
        return {
            turnContractId: ulid(),
            parentGoalId: goal.goalId,
            parentPlanNodeId: 'react-1',
            statement: goal.statement,
            tags: tooling ? ['tools', 'general'] : ['general'],
            success: goal.success,
            failureSignals:
                (goal.metadata?.failureSignals as TurnContract['failureSignals'] | undefined) ??
                defaultFailureSignals(),
            requiredTools,
            maxPermission: goal.permissionCeiling,
            budget: {
                maxSteps: goal.budget.maxSteps,
                maxCostUsd: goal.budget.maxCostUsd,
                timeoutMs: goal.budget.timeoutMs ?? goal.termination.timeoutMs,
            },
            expectedSideEffects: [],
            rollback: {
                strategy: goal.rollbackPolicy.strategy,
                description: goal.rollbackPolicy.description,
            },
            termination: {
                maxSteps: goal.termination.maxSteps,
                timeoutMs: goal.termination.timeoutMs,
                conditions: goal.termination.conditions,
            },
        };
    }

    /**
     * 单个 Turn 的完整编排：组装 capacity → 安全整轮重试 →（可选）Reflector 验收。
     * Driver 级瞬时错误且尚未产生任何 Step 时按 maxRetries 安全整轮重试；
     * 其余失败（blocked-tool/timeout/budget/max-steps/acceptance）→ turn 保持 failed。
     */
    private async executeTurn(
        ctx: StrategyContext,
        contract: TurnContract,
        reflect: boolean,
    ): Promise<void> {
        const session = ctx.session;
        const planner = ctx.planner;
        if (!planner) {
            throw new Error('full-loop 需要 planner 已注入');
        }
        const executor = ctx.executor as Executor;
        const turn: Turn = {
            turnId: ulid(),
            sessionId: session.sessionId,
            contract,
            stepIds: [],
            status: 'pending',
            attempt: 1,
        };
        session.turns.push(turn);
        let capacity: Capacity;
        try {
            capacity = await planner.assembleCapacity(turn);
        } catch (error) {
            turn.status = 'failed';
            await ctx.memory.saveTurn(turn);
            ctx.emit(
                newHarnessEvent({
                    type: 'turn.ended',
                    sessionId: session.sessionId,
                    turnId: turn.turnId,
                    payload: {
                        turnId: turn.turnId,
                        status: 'failed',
                        reason: (error as Error).message,
                    },
                }),
            );
            return;
        }
        turn.capacity = capacity;
        await ctx.memory.saveTurn(turn);
        ctx.emit(
            newHarnessEvent({
                type: 'turn.started',
                sessionId: session.sessionId,
                turnId: turn.turnId,
                attributes: {},
                payload: { turnId: turn.turnId },
            }),
        );

        const maxRetries = retryBudget(contract);
        let outcome: TurnExecutionOutcome | undefined;
        for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
            turn.attempt = attempt;
            await ctx.memory.saveTurn(turn);
            outcome = await executor.executeTurn(turn, capacity);
            if (outcome.ok) {
                break;
            }
            const retryable =
                outcome.error?.retryable === true &&
                outcome.steps.length === 0 &&
                attempt <= maxRetries;
            if (!retryable) {
                break;
            }
            ctx.emit(
                newHarnessEvent({
                    type: 'turn.ended',
                    sessionId: session.sessionId,
                    turnId: turn.turnId,
                    payload: {
                        turnId: turn.turnId,
                        status: 'failed',
                        attempt,
                        retrying: true,
                    },
                }),
            );
        }
        const ok = outcome?.ok === true;
        const final = outcome?.finalMessage;
        let accepted = ok;
        if (reflect) {
            const reflector = ctx.reflector ?? new MechanicalReflector();
            const verdict = await reflector.reflect({
                sessionId: turn.sessionId,
                turnId: turn.turnId,
                success: contract.success,
                outcomeOk: ok,
                finalMessage: final,
            });
            accepted = verdict.accepted;
        }
        if (ok && !accepted) {
            turn.status = 'failed';
            await ctx.memory.saveTurn(turn);
        }
        ctx.emit(
            newHarnessEvent({
                type: 'turn.ended',
                sessionId: session.sessionId,
                turnId: turn.turnId,
                payload: {
                    turnId: turn.turnId,
                    status: turn.status,
                    accepted,
                    finalMessage: final,
                    reason: outcome?.error?.code,
                },
            }),
        );
    }
}

/** 兼容 core Planner（TurnContract[]）与 MvpPlanner 适配器返回 */
function normalizeContracts(
    plan: Turn['contract'][] | { contracts: Turn['contract'][] },
): Turn['contract'][] {
    if (Array.isArray(plan)) {
        return plan;
    }
    return plan.contracts;
}

function retryBudget(contract: Turn['contract']): number {
    const toolError = contract.failureSignals.find((s) => s.kind === 'tool-error');
    return Math.max(0, toolError?.maxRetries ?? 0);
}
