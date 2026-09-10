import { describe, expect, it } from 'vitest';
import type { GoalTreeSnapshot, StepUsage } from '../src/types.ts';
import {
    aggregateUsage,
    buildAuditView,
    conicGradient,
    contextSegments,
    donutShares,
    formatCost,
    formatDuration,
    formatPercent,
    formatRate,
    formatSigned,
    formatTokens,
} from '../src/scripts/audit.ts';

function stepUsage(over: Partial<StepUsage> = {}): StepUsage {
    return {
        vendor: {
            inputTokens: 100,
            outputTokens: 20,
            reasoningOutputTokens: 5,
            cacheReadInputTokens: 40,
            totalTokens: 120,
        },
        runtime: {
            totalContextTokens: 1000,
            systemPromptTokens: 400,
            historyTokens: 300,
            historyUserTokens: 100,
            historyAssistantTokens: 150,
            toolCallTokens: 50,
            toolSchemaTokens: 100,
            newInputTokens: 100,
            observationTokens: 100,
            contextDeltaFromPrev: 0,
            contextWindowUtilization: 0.02,
            contents: {
                systemPrompt: 'SYS',
                historyUser: 'UH',
                historyAssistant: 'AH',
                toolCalls: 'TC',
                toolSchema: 'TS',
                newInput: 'NI',
                observation: 'OB',
                retrieved: '',
                examples: '',
            },
            diffContent: '[user]\nNI',
        },
        estimate: { outputTokens: 18 },
        cost: {
            inputCostUsd: 0.001,
            outputCostUsd: 0.001,
            cacheWriteCostUsd: 0,
            cacheReadCostUsd: 0,
            reasoningCostUsd: 0,
            totalCostUsd: 0.002,
            priceTierApplied: 'off-peak',
            pricingVersion: 'v1',
            currency: 'USD',
        },
        estimatedCost: {
            inputCostUsd: 0.0008,
            outputCostUsd: 0.0007,
            cacheWriteCostUsd: 0,
            cacheReadCostUsd: 0,
            reasoningCostUsd: 0,
            totalCostUsd: 0.0015,
            priceTierApplied: 'off-peak',
            pricingVersion: 'v1',
            currency: 'USD',
        },
        timing: { ttftMs: 100, totalMs: 300, tokensPerSecond: 100 },
        ...over,
    };
}

function stepView(
    stepId: string,
    kind: string,
    startedAt: number,
    usage: StepUsage | null,
): GoalTreeSnapshot['goals'][number]['tasks'][number]['steps'][number] {
    return {
        stepId,
        goalId: 'g1',
        taskId: 't1',
        kind: kind as never,
        status: 'ok',
        startedAt,
        endedAt: startedAt + 200,
        content: 'content of ' + stepId,
        ...(usage ? { usage } : {}),
    };
}

function snapshotOf(
    steps: ReturnType<typeof stepView>[],
): GoalTreeSnapshot {
    return {
        rootGoalId: 'root',
        taskCount: 1,
        stepCount: steps.length,
        goals: [
            {
                goalId: 'g1',
                kind: 'work',
                status: 'succeeded',
                statement: 'do the thing',
                tasks: [{ taskId: 't1', status: 'succeeded', title: 'Read file', steps }],
            },
        ],
    };
}

describe('audit aggregateUsage', () => {
    it('vendor 求和含 total；估算 input/output 漂移；双口径 cost 与 timing', () => {
        const usage = aggregateUsage([{ startedAt: 1, usage: stepUsage() }]);
        expect(usage.vendor?.input).toBe(100);
        expect(usage.vendor?.output).toBe(20);
        expect(usage.vendor?.reasoning).toBe(5);
        expect(usage.vendor?.cacheRead).toBe(40);
        expect(usage.vendor?.total).toBe(120);
        expect(usage.estimate?.inputTotal).toBe(1000);
        expect(usage.estimate?.inputDrift).toBe(900);
        expect(usage.estimate?.inputDriftRate).toBeCloseTo(9, 6);
        expect(usage.estimate?.outputTotal).toBe(18);
        // vendor 非 reasoning output = 20 - 5 = 15
        expect(usage.estimate?.outputDrift).toBe(3);
        expect(usage.estimate?.outputDriftRate).toBeCloseTo(0.2, 6);
        expect(usage.cost?.total).toBeCloseTo(0.002, 12);
        expect(usage.estimatedCost?.total).toBeCloseTo(0.0015, 12);
        expect(usage.timing?.totalMs).toBe(300);
    });

    it('多步求和：vendor/cost/estimate 累加，runtime 取最新一轮', () => {
        const usage = aggregateUsage([
            { startedAt: 1, usage: stepUsage() },
            {
                startedAt: 2,
                usage: stepUsage({
                    vendor: { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
                    runtime: {
                        totalContextTokens: 1200,
                        systemPromptTokens: 400,
                        historyTokens: 400,
                        historyUserTokens: 200,
                        historyAssistantTokens: 150,
                        toolCallTokens: 50,
                        toolSchemaTokens: 100,
                        newInputTokens: 100,
                        observationTokens: 200,
                    },
                    estimate: { outputTokens: 8 },
                }),
            },
        ]);
        expect(usage.vendor?.input).toBe(150);
        expect(usage.vendor?.output).toBe(30);
        expect(usage.vendor?.total).toBe(180);
        expect(usage.estimate?.inputTotal).toBe(2200);
        // 2200 - 150 = 2050
        expect(usage.estimate?.inputDrift).toBe(2050);
        expect(usage.estimate?.outputTotal).toBe(26);
        // vendor 非 reasoning = 30 - 5 = 25
        expect(usage.estimate?.outputDrift).toBe(1);
        expect(usage.cost?.total).toBeCloseTo(0.004, 12);
        expect(usage.runtime?.totalContextTokens).toBe(1200);
    });

    it('无 usage → 空聚合', () => {
        const usage = aggregateUsage([{ startedAt: 1 }, { startedAt: 2, usage: null }]);
        expect(usage).toEqual({
            vendor: null,
            runtime: null,
            estimate: null,
            cost: null,
            estimatedCost: null,
            timing: null,
        });
    });
});

describe('audit contextSegments', () => {
    it('细分为 system/user history/assistant/tool-call/schema/input/observation 并算占比', () => {
        const segments = contextSegments(stepUsage().runtime);
        expect(segments.map((s) => s.key)).toEqual([
            'system',
            'historyUser',
            'historyAssistant',
            'toolCall',
            'toolSchema',
            'newInput',
            'observation',
        ]);
        expect(segments[0]?.ratio).toBeCloseTo(0.4, 6);
        expect(segments[1]?.ratio).toBeCloseTo(0.1, 6);
        expect(segments[2]?.ratio).toBeCloseTo(0.15, 6);
        expect(segments[3]?.ratio).toBeCloseTo(0.05, 6);
    });

    it('旧数据只有 historyTokens → 单段 history', () => {
        const segments = contextSegments({
            totalContextTokens: 1000,
            systemPromptTokens: 500,
            historyTokens: 300,
            toolSchemaTokens: 100,
            newInputTokens: 50,
            observationTokens: 50,
        });
        expect(segments.map((s) => s.key)).toEqual([
            'system',
            'history',
            'toolSchema',
            'newInput',
            'observation',
        ]);
        expect(segments[1]?.tokens).toBe(300);
    });

    it('可选段为 0 时省略；原文按段映射；无 runtime → 空数组', () => {
        const segments = contextSegments(stepUsage().runtime);
        expect(segments.some((s) => s.key === 'retrieved')).toBe(false);
        const byKey = new Map(segments.map((s) => [s.key, s.content]));
        expect(byKey.get('system')).toBe('SYS');
        expect(byKey.get('historyAssistant')).toBe('AH');
        expect(byKey.get('observation')).toBe('OB');
        expect(contextSegments(null)).toEqual([]);
    });
});

describe('audit conicGradient', () => {
    it('按占比拼接 conic-gradient，覆盖 0%~100%', () => {
        const gradient = conicGradient(contextSegments(stepUsage().runtime));
        expect(gradient.startsWith('conic-gradient(')).toBe(true);
        expect(gradient).toContain('var(--seg-system)');
        expect(gradient).toContain('0.000%');
        expect(gradient).toContain('100.000%');
    });

    it('空段回落 border', () => {
        expect(conicGradient([])).toBe('conic-gradient(var(--border) 0% 100%)');
    });

    it('归一化 + 保底：极小占比也获得最小扇区，总和为 1', () => {
        const segments = [
            { key: 'a', label: 'a', tokens: 9970, ratio: 0.997, colorVar: '--seg-system', content: '' },
            { key: 'b', label: 'b', tokens: 20, ratio: 0.002, colorVar: '--seg-user', content: '' },
            { key: 'c', label: 'c', tokens: 10, ratio: 0.001, colorVar: '--seg-input', content: '' },
        ];
        const shares = donutShares(segments, 0.03);
        expect(shares.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 6);
        expect(shares[1]).toBeGreaterThanOrEqual(0.03 - 1e-9);
        expect(shares[2]).toBeGreaterThanOrEqual(0.03 - 1e-9);
        expect(shares[0] ?? 0).toBeGreaterThan(0.9);
    });
});

describe('audit buildAuditView', () => {
    it('step 目标：diff / 同 Task 明细 / cost 漂移 / 总量对照', () => {
        const snapshot = snapshotOf([stepView('s1', 'thinking', 1, stepUsage())]);
        const view = buildAuditView({ snapshot, stepId: 's1' });
        expect(view.kind).toBe('step');
        expect(view.title).toContain('S#1');
        expect(view.diff).toEqual({ delta: 0, from: 1000, to: 1000 });
        // 单步骤不展示步骤明细
        expect(view.rows).toHaveLength(0);
        expect(view.diffContent).toContain('NI');
        expect(view.estimatedTotal).toBe(1018);
        expect(view.vendorTotal).toBe(120);
        expect(view.costDrift?.usd).toBeCloseTo(-0.0005, 12);
        expect(view.costDrift?.rate).toBeCloseTo(-0.25, 6);
    });

    it('task 目标：聚合多步漂移，diff 为 null', () => {
        const snapshot = snapshotOf([
            stepView('s1', 'thinking', 1, stepUsage()),
            stepView('s2', 'tool_call', 2, null),
        ]);
        const view = buildAuditView({ snapshot, taskId: 't1' });
        expect(view.kind).toBe('task');
        expect(view.title).toBe('T#1 · Read file');
        expect(view.diff).toBeNull();
        expect(view.usage.vendor?.total).toBe(120);
        expect(view.usage.estimate?.inputDrift).toBe(900);
        expect(view.rows.map((r) => r.contextTotal)).toEqual([1000, null]);
    });

    it('run 目标 / stale / live 回退', () => {
        const snapshot = snapshotOf([stepView('s1', 'thinking', 1, stepUsage())]);
        const run = buildAuditView({ snapshot, runInput: 'hello' });
        expect(run.kind).toBe('run');
        expect(run.subtitle).toBe('hello');
        const stale = buildAuditView({ snapshot, stepId: 'missing' });
        expect(stale.kind).toBe('none');
        expect(stale.stale).toBe(true);
        const live = buildAuditView({
            snapshot: null,
            stepId: 'live1',
            liveSteps: [
                {
                    stepId: 'live1',
                    taskId: 't1',
                    kind: 'thinking',
                    toolName: '',
                    content: 'live',
                    status: 'running',
                    startedAt: 1,
                    endedAt: null,
                    usage: stepUsage(),
                },
            ],
        });
        expect(live.kind).toBe('step');
        expect(live.rows).toHaveLength(0);
        expect(live.usage.vendor?.total).toBe(120);
    });
});

describe('audit formatting', () => {
    it('formatTokens / formatCost / formatPercent / formatDuration', () => {
        expect(formatTokens(0)).toBe('0');
        expect(formatTokens(1500)).toBe('1.5K');
        expect(formatTokens(2000000)).toBe('2M');
        expect(formatCost(0)).toBe('$0');
        expect(formatCost(0.0012)).toBe('$0.001200');
        expect(formatPercent(0.785)).toBe('78.5%');
        expect(formatDuration(90_000)).toBe('1m 30s');
    });

    it('formatSigned / formatRate', () => {
        expect(formatSigned(900)).toBe('+900');
        expect(formatSigned(-5)).toBe('-5');
        expect(formatSigned(null)).toBe('-');
        expect(formatRate(0.2)).toBe('+20.0%');
        expect(formatRate(-0.25)).toBe('-25.0%');
        expect(formatRate(null)).toBe('-');
    });
});
