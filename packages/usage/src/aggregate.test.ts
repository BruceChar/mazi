import type { RuntimeContextBreakdown, Session, Step, Usage, VendorUsage } from '@mazi/core';
import { describe, expect, it } from 'vitest';
import {
    backfillDrift,
    buildSessionAggregate,
    emptyTokenTotals,
    isDriftExcessive,
    mergeTokenTotals,
    stepUsageToTokenTotals,
} from './aggregate.js';

/* ---------- 测试夹具（仅构造被测函数读取的最小字段） ---------- */

function makeVendorUsage(overrides: Partial<VendorUsage> = {}): VendorUsage {
    return { inputTokens: 0, outputTokens: 0, reportedByVendor: true, ...overrides };
}

function makeUsage(vendor: VendorUsage, totalCostUsd: number): Usage {
    return {
        vendor,
        runtime: {} as RuntimeContextBreakdown,
        cost: {
            inputCostUsd: 0,
            outputCostUsd: 0,
            cacheWriteCostUsd: 0,
            cacheReadCostUsd: 0,
            reasoningCostUsd: 0,
            totalCostUsd,
            priceTierApplied: 'base',
            pricingVersion: 'v1',
            currency: 'USD',
            calculatedAt: 0,
        },
        timing: { ttftMs: 1, totalMs: 1, tokensPerSecond: 1 },
    };
}

function makeRuntime(totalContextTokens: number): RuntimeContextBreakdown {
    return {
        systemPromptTokens: 0,
        systemPromptRatio: 0,
        historyTokens: 0,
        toolSchemaTokens: 0,
        newInputTokens: 0,
        observationTokens: 0,
        retrievedTokens: 0,
        exampleTokens: 0,
        totalContextTokens,
        contextWindowUtilization: 0,
        contextDeltaFromPrev: 0,
        strategyApplied: [],
    };
}

function makeStep(seq: number, usage?: Usage): Step {
    return {
        stepId: 'step-'.concat(String(seq)),
        turnId: 'turn-1',
        sessionId: 'sess-1',
        seq,
        kind: 'thinking',
        payload: { content: 'step-'.concat(String(seq)) },
        usage,
        status: 'ok',
        startedAt: 1000 + seq,
        endedAt: 2000 + seq,
    };
}

function makeSession(createdAt: number): Session {
    return {
        sessionId: 'sess-1',
        rawIntent: '示例任务',
        goal: {} as Session['goal'],
        strategyId: 'full-loop',
        state: 'succeeded',
        turns: [],
        flagSnapshot: {} as Session['flagSnapshot'],
        createdAt,
    };
}

/* ---------- 用例 ---------- */

describe('usage 聚合与漂移（MVP v1.0 §5.2 / §8 F6）', () => {
    it('emptyTokenTotals 全零；mergeTokenTotals 逐分类相加', () => {
        expect(emptyTokenTotals()).toEqual({
            input: 0,
            output: 0,
            cacheWrite: 0,
            cacheRead: 0,
            reasoning: 0,
        });
        const merged = mergeTokenTotals(
            { input: 1, output: 2, cacheWrite: 3, cacheRead: 4, reasoning: 5 },
            { input: 10, output: 20, cacheWrite: 30, cacheRead: 40, reasoning: 50 },
        );
        expect(merged).toEqual({
            input: 11,
            output: 22,
            cacheWrite: 33,
            cacheRead: 44,
            reasoning: 55,
        });
    });

    it('stepUsageToTokenTotals 映射 vendor 计数（cache/reasoning 缺省为 0）；无 usage 全零', () => {
        const withUsage = makeStep(
            1,
            makeUsage(
                makeVendorUsage({
                    inputTokens: 1000,
                    outputTokens: 500,
                    cacheCreationInputTokens: 100,
                    cacheReadInputTokens: 200,
                    reasoningOutputTokens: 50,
                }),
                0.01,
            ),
        );
        expect(stepUsageToTokenTotals(withUsage)).toEqual({
            input: 1000,
            output: 500,
            cacheWrite: 100,
            cacheRead: 200,
            reasoning: 50,
        });
        // 未挂 usage 的 step（如 observation）
        expect(stepUsageToTokenTotals(makeStep(2))).toEqual(emptyTokenTotals());
    });

    it('buildSessionAggregate 按 turn 状态计数并累计 steps/token/cost', () => {
        const createdAt = Date.now() - 10_000;
        const aggregate = buildSessionAggregate({
            session: makeSession(createdAt),
            turns: [
                {
                    status: 'succeeded',
                    steps: [
                        makeStep(
                            1,
                            makeUsage(
                                makeVendorUsage({
                                    inputTokens: 1000,
                                    outputTokens: 500,
                                    cacheCreationInputTokens: 100,
                                }),
                                0.0021,
                            ),
                        ),
                        makeStep(2), // 无 usage，不计入 token/cost
                    ],
                },
                {
                    status: 'failed',
                    steps: [
                        makeStep(
                            1,
                            makeUsage(
                                makeVendorUsage({
                                    inputTokens: 2000,
                                    outputTokens: 0,
                                    reasoningOutputTokens: 300,
                                }),
                                0.0035,
                            ),
                        ),
                    ],
                },
                { status: 'rolled_back', steps: [makeStep(1)] },
                { status: 'running', steps: [] }, // 未结束 turn：计入 totalTurns，不计成功/失败
            ],
        });
        expect(aggregate.totalTurns).toBe(4);
        expect(aggregate.succeededTurns).toBe(1);
        expect(aggregate.failedTurns).toBe(1);
        expect(aggregate.rolledBackTurns).toBe(1);
        expect(aggregate.totalSteps).toBe(4); // 2 + 1 + 1 + 0
        expect(aggregate.totalTokens).toEqual({
            input: 3000,
            output: 500,
            cacheWrite: 100,
            cacheRead: 0,
            reasoning: 300,
        });
        expect(aggregate.totalCostUsd).toBeCloseTo(0.0056);
        expect(aggregate.totalDurationMs).toBeGreaterThanOrEqual(10_000);
        expect(aggregate.contextStrategyInvocations).toEqual({
            truncate: 0,
            summarize: 0,
            retrieve: 0,
            compressObservation: 0,
            cachePromptPrefix: 0,
        });
    });

    it('backfillDrift 写回 runtime.estimationDriftTokens 并返回漂移值', () => {
        const runtime = makeRuntime(1000);
        const vendor = makeVendorUsage({ inputTokens: 940 });
        const drift = backfillDrift(runtime, vendor);
        expect(drift).toBe(60);
        expect(runtime.estimationDriftTokens).toBe(60);
    });

    it('isDriftExcessive 阈值严格大于 5%；total=0 时任何正漂移超限', () => {
        expect(isDriftExcessive(49, 1000)).toBe(false); // 4.9%
        expect(isDriftExcessive(50, 1000)).toBe(false); // 恰好 5% 不超
        expect(isDriftExcessive(51, 1000)).toBe(true); // 5.1%
        expect(isDriftExcessive(0, 0)).toBe(false);
        expect(isDriftExcessive(1, 0)).toBe(true);
    });
});
