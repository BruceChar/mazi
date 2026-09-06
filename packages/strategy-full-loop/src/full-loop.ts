import type {
    HarnessStrategy,
    StrategyCapabilities,
    StrategyContext,
    StrategyEvent,
    Turn,
} from '@mazi/core';
import { ulid } from '@mazi/core';
import type { Executor, TurnExecutionOutcome } from '@mazi/executor';
import { newHarnessEvent } from '@mazi/observability';
import { MechanicalReflector } from './reflector.js';

const CAPABILITIES: StrategyCapabilities = {
    needsGoal: true,
    needsPlan: true,
    needsExecute: true,
    needsObserve: true,
    needsReflect: true,
    needsPersistentState: true,
};

/**
 * Full-Loop 策略（feature F12）：Goal→Plan→Execute→机械验收→failureSignals 处理。
 * - 通过 ctx.planner（core Planner，运行时由 MvpPlanner 适配）plan/assembleCapacity；
 * - 通过 ctx.executor（@mazi/executor 具体实现）执行 Turn；
 * - 失败处理（MVP 子集）：driver 级瞬时错误且尚未产生任何 Step → 按 maxRetries 安全整轮重试；
 *   其余失败（blocked-tool/timeout/budget/max-steps/acceptance）→ abort-turn（turn 保持 failed）。
 */
export class FullLoopStrategy implements HarnessStrategy {
    readonly id = 'full-loop';
    readonly version = '0.1.0';
    readonly capabilities = CAPABILITIES;

    score(): number {
        return 1;
    }

    async *run(ctx: StrategyContext): AsyncIterable<StrategyEvent> {
        const session = ctx.session;
        const goal = session.goal;
        const planner = ctx.planner;
        const executor = ctx.executor as Executor | undefined;
        if (!planner || !executor) {
            throw new Error('full-loop 需要 planner 与 executor 已注入');
        }
        ctx.emit(
            newHarnessEvent({
                type: 'strategy.selected',
                sessionId: session.sessionId,
                attributes: { 'harness.strategy_id': this.id },
                payload: { strategyId: this.id, version: this.version },
            }),
        );

        const planResult = await planner.plan(goal);
        const contracts = normalizeContracts(planResult);
        for (const contract of contracts) {
            const turn: Turn = {
                turnId: ulid(),
                sessionId: session.sessionId,
                contract,
                stepIds: [],
                status: 'pending',
                attempt: 1,
            };
            session.turns.push(turn);
            let capacity: Awaited<
                ReturnType<NonNullable<StrategyContext['planner']>['assembleCapacity']>
            >;
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
                continue;
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
                        payload: { turnId: turn.turnId, status: 'failed', attempt, retrying: true },
                    }),
                );
            }
            const ok = outcome?.ok === true;
            const final = outcome?.finalMessage;
            const reflector = ctx.reflector ?? new MechanicalReflector();
            const verdict = await reflector.reflect({
                sessionId: turn.sessionId,
                turnId: turn.turnId,
                success: contract.success,
                outcomeOk: ok,
                finalMessage: final,
            });
            const accepted = verdict.accepted;
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
        // 生成器契约：事件已通过 ctx.emit 送达总线；此处仅确保迭代完成时提供空流
        yield* [];
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
