import { describe, expect, it } from 'vitest';
import type { GoalTreeSnapshot, StepUsage } from '../src/types.ts';
import {
    aggregateUsage,
    buildAuditView,
    contextSegments,
    formatCost,
    formatDuration,
    formatPercent,
    formatTokens,
} from '../src/scripts/audit.ts';

function vendor(input: number, output: number): StepUsage['vendor'] {
    return { inputTokens: input, outputTokens: output };
}

function runtime(
    total: number,
    delta: number,
    segments: Partial<NonNullable<StepUsage['runtime']>> = {},
): NonNullable<StepUsage['runtime']> {
    return {
        totalContextTokens: total,
        systemPromptTokens: 400,
        historyTokens: 300,
        toolSchemaTokens: 100,
        newInputTokens: 100,
        observationTokens: 100,
        contextWindowUtilization: 0.1,
        contextDeltaFromPrev: delta,
        strategyApplied: ['sliding-window'],
        ...segments,
    };
}

function cost(total: number): NonNullable<StepUsage['cost']> {
    return {
        inputCostUsd: total / 2,
        outputCostUsd: total / 2,
        cacheWriteCostUsd: 0,
        cacheReadCostUsd: 0,
        reasoningCostUsd: 0,
        totalCostUsd: total,
        priceTierApplied: 'off-peak',
        pricingVersion: 'v1',
        currency: 'USD',
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

function snapshotOf(steps: ReturnType<typeof stepView>[]): GoalTreeSnapshot {
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
    it('vendor/cost 求和，runtime 取最新，timing 取平均 TTFT 与总吞吐', () => {
        const usage = aggregateUsage([
            {
                startedAt: 1,
                usage: {
                    vendor: vendor(100, 20),
                    runtime: runtime(1000, 0),
                    cost: cost(0.002),
                    timing: { ttftMs: 100, totalMs: 300, tokensPerSecond: 100 },
                },
            },
            {
                startedAt: 2,
                usage: {
                    vendor: vendor(50, 30),
                    runtime: runtime(1200, 200),
                    cost: cost(0.001),
                    timing: { ttftMs: 200, totalMs: 400, tokensPerSecond: 150 },
                },
            },
        ]);
        expect(usage.vendor?.input).toBe(150);
        expect(usage.vendor?.output).toBe(50);
        expect(usage.vendor?.total).toBe(200);
        expect(usage.cost?.total).toBeCloseTo(0.003, 12);
        expect(usage.cost?.tier).toBe('off-peak');
        expect(usage.runtime?.totalContextTokens).toBe(1200);
        expect(usage.runtime?.contextDeltaFromPrev).toBe(200);
        expect(usage.timing?.totalMs).toBe(700);
        expect(usage.timing?.ttftMs).toBeCloseTo(150, 6);
        // output=50, generation = 700 - 300 = 400ms
        expect(usage.timing?.tokensPerSecond).toBeCloseTo((50 / 400) * 1000, 6);
    });

    it('无 usage 步骤不参与聚合', () => {
        const usage = aggregateUsage([{ startedAt: 1 }, { startedAt: 2, usage: null }]);
        expect(usage).toEqual({ vendor: null, runtime: null, cost: null, timing: null });
    });
});

describe('audit contextSegments', () => {
    it('按 totalContextTokens 计算占比，五段固定出现', () => {
        const segments = contextSegments(runtime(1000, 0));
        expect(segments.map((s) => s.key)).toEqual([
            'system',
            'history',
            'toolSchema',
            'newInput',
            'observation',
        ]);
        expect(segments[0]?.ratio).toBeCloseTo(0.4, 6);
        expect(segments[1]?.ratio).toBeCloseTo(0.3, 6);
    });

    it('total 为 0 时回落分段和；可选段为 0 时省略、非 0 时出现', () => {
        const segments = contextSegments(
            runtime(0, 0, { retrievedTokens: 0, exampleTokens: 200 }),
        );
        const sum = 400 + 300 + 100 + 100 + 100 + 200;
        expect(segments[0]?.ratio).toBeCloseTo(400 / sum, 6);
        expect(segments.some((s) => s.key === 'retrieved')).toBe(false);
        expect(segments.some((s) => s.key === 'example')).toBe(true);
    });

    it('无 runtime → 空数组', () => {
        expect(contextSegments(null)).toEqual([]);
    });
});

describe('audit buildAuditView', () => {
    it('step 目标：标题/正文/diff/占比与同 Task 明细', () => {
        const snapshot = snapshotOf([
            stepView('s1', 'thinking', 1, {
                vendor: vendor(100, 20),
                runtime: runtime(1000, 0),
                cost: cost(0.002),
                timing: { ttftMs: 100, totalMs: 300, tokensPerSecond: 100 },
            }),
            stepView('s2', 'tool_call', 2, {
                vendor: vendor(50, 30),
                runtime: runtime(1200, 200),
                cost: cost(0.001),
                timing: { ttftMs: 200, totalMs: 400, tokensPerSecond: 150 },
            }),
            stepView('s3', 'intent', 3, null),
        ]);
        const view = buildAuditView({ snapshot, stepId: 's1' });
        expect(view.kind).toBe('step');
        expect(view.stale).toBe(false);
        expect(view.title).toContain('S#1');
        expect(view.title).toContain('thinking');
        expect(view.text).toBe('content of s1');
        expect(view.diff).toEqual({ delta: 0, from: 1000, to: 1000 });
        expect(view.segments).toHaveLength(5);
        expect(view.rows).toHaveLength(3);
        expect(view.rows[0]?.selected).toBe(true);
        expect(view.rows[2]?.contextTotal).toBeNull();
    });

    it('task 目标：聚合多步 vendor/cost，runtime 取最新，diff 为 null', () => {
        const snapshot = snapshotOf([
            stepView('s1', 'thinking', 1, { vendor: vendor(100, 20), runtime: runtime(1000, 0), cost: cost(0.002) }),
            stepView('s2', 'tool_call', 2, { vendor: vendor(50, 30), runtime: runtime(1200, 200), cost: cost(0.001) }),
        ]);
        const view = buildAuditView({ snapshot, taskId: 't1' });
        expect(view.kind).toBe('task');
        expect(view.title).toBe('T#1 · Read file');
        expect(view.usage.vendor?.input).toBe(150);
        expect(view.usage.cost?.total).toBeCloseTo(0.003, 12);
        expect(view.usage.runtime?.totalContextTokens).toBe(1200);
        expect(view.diff).toBeNull();
        expect(view.rows.map((r) => r.contextDelta)).toEqual([0, 200]);
    });

    it('run 目标：无 step/task 指定时汇总全部步骤', () => {
        const snapshot = snapshotOf([
            stepView('s1', 'thinking', 1, { vendor: vendor(10, 5) }),
        ]);
        const view = buildAuditView({ snapshot, runInput: 'hello' });
        expect(view.kind).toBe('run');
        expect(view.title).toBe('Run 汇总');
        expect(view.subtitle).toBe('hello');
        expect(view.usage.vendor?.total).toBe(15);
    });

    it('选中 Step 不在快照中 → stale', () => {
        const snapshot = snapshotOf([stepView('s1', 'thinking', 1, null)]);
        const view = buildAuditView({ snapshot, stepId: 'missing' });
        expect(view.kind).toBe('none');
        expect(view.stale).toBe(true);
    });

    it('执行中：快照缺失时回退实时步骤', () => {
        const view = buildAuditView({
            snapshot: null,
            stepId: 'live1',
            liveSteps: [
                {
                    stepId: 'live1',
                    taskId: 't1',
                    kind: 'thinking',
                    toolName: '',
                    content: 'live thinking',
                    status: 'running',
                    startedAt: 1,
                    endedAt: null,
                    usage: { vendor: vendor(7, 3) },
                },
            ],
        });
        expect(view.kind).toBe('step');
        expect(view.title).toContain('S#1');
        expect(view.text).toBe('live thinking');
        expect(view.usage.vendor?.total).toBe(10);
    });

    it('未选择任何目标 → run 汇总（snapshot 为空）', () => {
        const view = buildAuditView({ snapshot: null });
        expect(view.kind).toBe('run');
        expect(view.rows).toHaveLength(0);
        expect(view.usage.vendor).toBeNull();
    });
});

describe('audit formatting', () => {
    it('formatTokens', () => {
        expect(formatTokens(0)).toBe('0');
        expect(formatTokens(999)).toBe('999');
        expect(formatTokens(1500)).toBe('1.5K');
        expect(formatTokens(2_000_000)).toBe('2M');
    });

    it('formatCost', () => {
        expect(formatCost(0)).toBe('$0');
        expect(formatCost(0.0012)).toBe('$0.001200');
    });

    it('formatPercent / formatDuration', () => {
        expect(formatPercent(0.785)).toBe('78.5%');
        expect(formatDuration(420)).toBe('420ms');
        expect(formatDuration(1500)).toBe('1.5s');
        expect(formatDuration(90_000)).toBe('1m 30s');
    });
});
