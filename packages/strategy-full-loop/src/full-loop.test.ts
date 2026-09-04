import type {
    Capacity,
    FlagSnapshot,
    GoalContract,
    HarnessEvent,
    MemoryStore,
    Planner,
    Session,
    StrategyContext,
    Turn,
    TurnContract,
} from '@mazi/core';
import { ulid } from '@mazi/core';
import type { TurnExecutionOutcome } from '@mazi/executor';
import { describe, expect, it } from 'vitest';
import { acceptanceMet, FullLoopStrategy } from './full-loop';

function stubFlag(): FlagSnapshot {
    return {
        values: {},
        trace: [],
        isEnabled: () => false,
        getNumber: () => undefined,
        getString: () => undefined,
    };
}

function goal(conditions: string[]): GoalContract {
    return {
        goalId: ulid(),
        sessionId: 'sess-s',
        statement: '测试任务',
        success: { conditions, description: '' },
        constraints: [],
        allowedTools: ['fs.read'],
        permissionCeiling: 'read-only',
        budget: { maxSteps: 8, maxCostUsd: 1 },
        termination: { maxSteps: 8 },
        rollbackPolicy: { strategy: 'none' },
        strategyHints: ['complex'],
    };
}

function contract(goal: GoalContract, failureMaxRetries = 1): TurnContract {
    return {
        turnContractId: ulid(),
        parentGoalId: goal.goalId,
        parentPlanNodeId: 'n1',
        statement: goal.statement,
        tags: ['tools', 'general'],
        success: goal.success,
        failureSignals: [{ kind: 'tool-error', action: 'retry', maxRetries: failureMaxRetries }],
        requiredTools: [],
        maxPermission: 'read-only',
        budget: { maxSteps: 8, maxCostUsd: 0.8 },
        expectedSideEffects: [],
        rollback: { strategy: 'none' },
        termination: { maxSteps: 8 },
    };
}

function capacity(): Capacity {
    return {
        model: { providerId: 'a', vendor: 'test', modelId: 'a-m' },
        tools: [],
        permission: 'read-only',
        budget: { maxSteps: 8, maxCostUsd: 0.8 },
        sandbox: { enabled: true },
        flags: stubFlag(),
    };
}

class MemoryStub implements MemoryStore {
    turns = new Map<string, Turn>();
    async saveSession(): Promise<void> {}
    async loadSession(): Promise<Session | undefined> {
        return undefined;
    }
    async saveTurn(t: Turn): Promise<void> {
        // capacity.flags 含函数，无法 structuredClone：存储时剥离（测试不依赖该字段）
        const stored = {
            ...t,
            capacity: t.capacity ? { ...t.capacity, flags: { values: {}, trace: [] } } : undefined,
        };
        this.turns.set(t.turnId, stored as Turn);
    }
    async listTurns(): Promise<Turn[]> {
        return [];
    }
    async saveStep(): Promise<void> {}
    async listSteps(): Promise<never[]> {
        return [];
    }
    async saveCheckpoint(): Promise<void> {}
    async loadCheckpoint(): Promise<undefined> {
        return undefined;
    }
    async saveUserInteractionRecord(): Promise<void> {}
    async loadUserInteractionRecord(): Promise<undefined> {
        return undefined;
    }
    async loadUserInteractionBySession(): Promise<undefined> {
        return undefined;
    }
    async listUserInteractionRecords(): Promise<never[]> {
        return [];
    }
}

interface StubExecutor {
    calls: { turn: Turn; capacity: Capacity }[];
    executeTurn: (
        turn: Turn,
        capacity: Capacity,
    ) => TurnExecutionOutcome | Promise<TurnExecutionOutcome>;
}

function makeExecutor(behavior: (turn: Turn) => TurnExecutionOutcome): StubExecutor {
    return {
        calls: [],
        executeTurn(turn: Turn, cap: Capacity) {
            this.calls.push({ turn, capacity: cap });
            return behavior(turn);
        },
    };
}

function sessionOf(goal: GoalContract): Session {
    return {
        sessionId: goal.sessionId,
        rawIntent: goal.statement,
        goal,
        strategyId: 'full-loop',
        state: 'running',
        turns: [],
        flagSnapshot: stubFlag(),
        createdAt: Date.now(),
    };
}

function makeCtx(
    goal: GoalContract,
    plannerOutcome: TurnContract,
    executor: StubExecutor,
): { ctx: StrategyContext; emitted: HarnessEvent[] } {
    const session = sessionOf(goal);
    const emitted: HarnessEvent[] = [];
    const planner: Planner = {
        plan: async () => [plannerOutcome],
        assembleCapacity: async () => capacity(),
    };
    return {
        ctx: {
            session,
            planner,
            executor: executor as unknown as StrategyContext['executor'],
            memory: new MemoryStub(),
            driver: {} as never,
            flags: stubFlag(),
            emit: (e: HarnessEvent) => void emitted.push(e),
        },
        emitted,
    };
}

async function runAll(ctx: StrategyContext): Promise<void> {
    for await (const _ of new FullLoopStrategy().run(ctx)) {
        // 事件经 ctx.emit 送达
    }
}

describe('acceptanceMet（MVP 机械验收）', () => {
    it('contains / regex / 普通子串条件判定', () => {
        expect(
            acceptanceMet({ conditions: ['contains:完成'], description: '' }, true, '任务完成'),
        ).toBe(true);
        expect(
            acceptanceMet({ conditions: ['contains:完成'], description: '' }, true, '任务中止'),
        ).toBe(false);
        expect(
            acceptanceMet({ conditions: ['regex:^任务\\d+$'], description: '' }, true, '任务42'),
        ).toBe(true);
        expect(
            acceptanceMet({ conditions: ['任意子串'], description: '' }, true, '含任意子串的文本'),
        ).toBe(true);
        expect(acceptanceMet({ conditions: [], description: '' }, false, 'x')).toBe(false);
        expect(
            acceptanceMet({ conditions: ['contains:x'], description: '' }, true, undefined),
        ).toBe(false);
    });
});

describe('FullLoopStrategy（MVP v1.0 §8 F12）', () => {
    it('成功路径：单 Turn 完成，turn.succeeded，事件含 strategy.selected/turn.ended(accepted=true)', async () => {
        const g = goal(['contains:完成']);
        const executor = makeExecutor((turn) => {
            turn.status = 'succeeded';
            return {
                ok: true,
                reason: 'final-answer',
                steps: [],
                finalMessage: '任务完成',
                accumulatedTokens: {
                    input: 10,
                    output: 5,
                    cacheWrite: 0,
                    cacheRead: 0,
                    reasoning: 0,
                },
                accumulatedCostUsd: 0.001,
            };
        });
        const { ctx, emitted } = makeCtx(g, contract(g), executor);
        await runAll(ctx);
        expect(ctx.session.turns).toHaveLength(1);
        expect(ctx.session.turns[0]?.status).toBe('succeeded');
        expect(emitted.map((e) => e.type)).toContain('strategy.selected');
        const turnEnded = emitted.filter((e) => e.type === 'turn.ended');
        expect(turnEnded.length).toBeGreaterThanOrEqual(1);
        const payload = turnEnded[0]?.payload as { accepted?: boolean } | undefined;
        expect(payload?.accepted).toBe(true);
    });

    it('瞬时 driver 错误整轮安全重试（maxRetries=1）', async () => {
        const g = goal([]);
        let attempts = 0;
        const executor = makeExecutor((turn) => {
            attempts++;
            turn.attempt = attempts;
            if (attempts === 1) {
                turn.status = 'failed';
                return {
                    ok: false,
                    reason: 'driver-error',
                    steps: [],
                    error: { code: 'driver-error', message: '瞬时故障', retryable: true },
                    accumulatedTokens: {
                        input: 0,
                        output: 0,
                        cacheWrite: 0,
                        cacheRead: 0,
                        reasoning: 0,
                    },
                    accumulatedCostUsd: 0,
                };
            }
            turn.status = 'succeeded';
            return {
                ok: true,
                reason: 'final-answer',
                steps: [],
                finalMessage: '完成',
                accumulatedTokens: {
                    input: 5,
                    output: 5,
                    cacheWrite: 0,
                    cacheRead: 0,
                    reasoning: 0,
                },
                accumulatedCostUsd: 0,
            };
        });
        const { ctx, emitted } = makeCtx(g, contract(g, 1), executor);
        await runAll(ctx);
        expect(attempts).toBe(2);
        expect(ctx.session.turns[0]?.status).toBe('succeeded');
        expect(emitted.some((e) => (e.payload as { retrying?: boolean })?.retrying === true)).toBe(
            true,
        );
    });

    it('不可重试失败（blocked-tool）→ 单次执行后 turn 保持 failed', async () => {
        const g = goal([]);
        const executor = makeExecutor((turn) => {
            turn.status = 'failed';
            return {
                ok: false,
                reason: 'blocked-tool',
                steps: [],
                error: { code: 'tool-blocked', message: '拦截', retryable: false },
                accumulatedTokens: {
                    input: 0,
                    output: 0,
                    cacheWrite: 0,
                    cacheRead: 0,
                    reasoning: 0,
                },
                accumulatedCostUsd: 0,
            };
        });
        const { ctx } = makeCtx(g, contract(g), executor);
        await runAll(ctx);
        expect(ctx.session.turns[0]?.status).toBe('failed');
        expect(ctx.session.turns[0]?.attempt).toBe(1);
    });
});
