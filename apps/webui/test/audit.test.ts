import { describe, expect, it } from 'vitest';
import type { GoalTreeSnapshot, StepUsage } from '../src/types.ts';
import {
    aggregateUsage,
    buildAuditView,
    conicGradient,
    contextSegments,
    donutArcs,
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
            diffContents: {
                systemPrompt: 'SYS',
                historyUser: '',
                historyAssistant: '',
                toolCalls: '',
                toolSchema: 'TS',
                newInput: 'NI',
                observation: '',
                retrieved: '',
                examples: '',
            },
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
    taskId = 't1',
): GoalTreeSnapshot['goals'][number]['tasks'][number]['steps'][number] {
    return {
        stepId,
        goalId: 'g1',
        taskId,
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
    taskId = 't1',
    title = 'Read file',
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
                tasks: [{ taskId, status: 'succeeded', title, steps }],
            },
        ],
    };
}

function withTotal(total: number): StepUsage {
    const base = stepUsage();
    return {
        ...base,
        runtime: { ...(base.runtime ?? {}), totalContextTokens: total },
    } as StepUsage;
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

    it('同 roundId 的 thinking + intent 只计一次（不同轮次仍累加）', () => {
        const shared = stepUsage({ roundId: 'r1' });
        const deduped = aggregateUsage([
            { startedAt: 1, usage: shared },
            { startedAt: 2, usage: shared },
        ]);
        expect(deduped.vendor?.input).toBe(100);
        expect(deduped.vendor?.output).toBe(20);
        expect(deduped.cost?.total).toBeCloseTo(0.002, 12);

        const twoRounds = aggregateUsage([
            { startedAt: 1, usage: stepUsage({ roundId: 'r1' }) },
            { startedAt: 2, usage: stepUsage({ roundId: 'r2' }) },
        ]);
        expect(twoRounds.vendor?.input).toBe(200);
        expect(twoRounds.vendor?.output).toBe(40);
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

    it('donutArcs：每段一个 SVG 扇区，含中角偏移', () => {
        const segments = contextSegments(stepUsage().runtime);
        const arcs = donutArcs(segments);
        expect(arcs).toHaveLength(segments.length);
        expect(arcs.every((arc) => arc.path.startsWith('M'))).toBe(true);
        expect(
            arcs.every((arc) => Number.isFinite(arc.offset.x) && Number.isFinite(arc.offset.y)),
        ).toBe(true);
    });

    it('donutArcs：单段整圆也可构造；空段 → 空数组', () => {
        const arcs = donutArcs([
            { key: 'a', label: 'a', tokens: 100, ratio: 1, colorVar: '--seg-system', content: '' },
        ]);
        expect(arcs).toHaveLength(1);
        expect(arcs[0]?.path.startsWith('M')).toBe(true);
        expect(donutArcs([])).toEqual([]);
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
    it('step 目标：单步无前序 → diff 为 null；无步骤明细；cost 漂移与总量对照', () => {
        const snapshot = snapshotOf([stepView('s1', 'thinking', 1, stepUsage())]);
        const view = buildAuditView({ snapshot, stepId: 's1' });
        expect(view.kind).toBe('step');
        expect(view.title).toContain('S#1');
        expect(view.diff).toBeNull();
        expect(view.rows).toHaveLength(0);
        expect(view.diffContent).toContain('NI');
        expect(view.estimatedTotal).toBe(1018);
        expect(view.vendorTotal).toBe(120);
        expect(view.costDrift?.usd).toBeCloseTo(-0.0005, 12);
        expect(view.costDrift?.rate).toBeCloseTo(-0.25, 6);
    });

    it('会话线：跨 run/task/step 全局编号与 context delta', () => {
        const run1 = snapshotOf(
            [
                stepView('a1', 'thinking', 1, withTotal(1000)),
                stepView('a2', 'tool_call', 2, withTotal(1200)),
            ],
            't1',
        );
        const run2 = snapshotOf(
            [stepView('b1', 'thinking', 3, withTotal(1500), 't2')],
            't2',
            'Second task',
        );
        const runs = [
            { rootGoalId: 'r1', input: 'q1', snapshot: run1 },
            { rootGoalId: 'r2', input: 'q2', snapshot: run2 },
        ];
        const conversation = buildAuditView({ runs });
        expect(conversation.kind).toBe('conversation');
        expect(conversation.rows.map((r) => r.lineIndex)).toEqual([1, 2, 3]);
        expect(conversation.rows.map((r) => r.runIndex)).toEqual([1, 1, 2]);
        // T# restarts at 1 for each run (Session), not accumulated.
        expect(conversation.rows.map((r) => r.taskIndex)).toEqual([1, 1, 1]);
        expect(conversation.rows.map((r) => r.contextDelta)).toEqual([null, 200, 300]);
        expect(conversation.rows[2]?.contextTotal).toBe(1500);
        // 每步的 diff 原文随行带出（Context 追踪用），并按段拆分为有序列表
        expect(conversation.rows[0]?.diffContent).toContain('NI');
        expect(conversation.rows[0]?.diffParts.map((part) => part.label)).toEqual([
            'system prompt',
            'tool schema',
            'user input',
        ]);

        const step = buildAuditView({ runs, stepId: 'b1' });
        expect(step.kind).toBe('step');
        expect(step.diff).toEqual({ delta: 300, from: 1200, to: 1500 });
    });

    it('tool_call 目标：专用 tool 视图（命令/参数/输出/耗时），非 vendor token', () => {
        const toolStep = {
            ...stepView('tc1', 'tool_call', 1, null),
            toolName: 'shell.run',
            toolArguments: { command: 'ls -la' },
            toolCwd: '/Users/bruce/.mazi',
            toolOutput: 'total 0',
        };
        const view = buildAuditView({ snapshot: snapshotOf([toolStep]), stepId: 'tc1' });
        expect(view.kind).toBe('step');
        expect(view.tool?.name).toBe('shell.run');
        expect(view.tool?.command).toBe('ls -la');
        // 完整工作路径 + 命令（home 缩短为 ~）
        expect(view.tool?.cwd).toBe('~/.mazi');
        expect(view.tool?.line).toBe('~/.mazi ls -la');
        expect(view.tool?.arguments).toEqual({ command: 'ls -la' });
        expect(view.tool?.output).toBe('total 0');
        expect(view.tool?.durationMs).toBe(200);
        expect(view.tool?.isError).toBe(false);

        // 单字符串参数 → 直接作为命令展示；非 shell.run 前缀工具名
        const fdStep = {
            ...stepView('tc2', 'tool_call', 2, null),
            toolName: 'fd',
            toolArguments: { pattern: '*' },
            toolCwd: '/Users/bruce/.mazi',
            toolOutput: 'a\nb',
        };
        const fd = buildAuditView({ snapshot: snapshotOf([fdStep]), stepId: 'tc2' });
        expect(fd.tool?.command).toBe('*');
        expect(fd.tool?.line).toBe('~/.mazi fd *');

        // 非工具步 tool = null
        const thinking = buildAuditView({
            snapshot: snapshotOf([stepView('s1', 'thinking', 1, stepUsage())]),
            stepId: 's1',
        });
        expect(thinking.tool).toBeNull();
    });

    it('task 目标：只列本任务步骤，diff 为 null', () => {
        const snapshot = snapshotOf([
            stepView('s1', 'thinking', 1, stepUsage()),
            stepView('s2', 'tool_call', 2, null),
        ]);
        const view = buildAuditView({ snapshot, taskId: 't1' });
        expect(view.kind).toBe('task');
        expect(view.title).toBe('R#1·T#1 · Read file');
        expect(view.diff).toBeNull();
        expect(view.usage.vendor?.total).toBe(120);
        expect(view.usage.estimate?.inputDrift).toBe(900);
        expect(view.rows.map((r) => r.contextTotal)).toEqual([1000, null]);
    });

    it('thinking + intent 折叠为同一轮一步，S# 不跳号', () => {
        const snapshot = snapshotOf([
            stepView('s1', 'thinking', 1, stepUsage()),
            stepView('s2', 'intent', 2, stepUsage()),
            stepView('s3', 'tool_call', 3, null),
        ]);
        const view = buildAuditView({ snapshot, taskId: 't1' });
        expect(view.rows.map((r) => r.kind)).toEqual(['thinking', 'tool_call']);
        expect(view.rows.map((r) => r.index)).toEqual([1, 2]);
        expect(view.rows.map((r) => r.lineIndex)).toEqual([1, 2]);
    });

    it('会话汇总 / stale / live 回退', () => {
        const snapshot = snapshotOf([stepView('s1', 'thinking', 1, stepUsage())]);
        const conversation = buildAuditView({
            runs: [{ rootGoalId: 'r1', input: 'q1', snapshot }],
            conversationTitle: 'hello',
        });
        expect(conversation.kind).toBe('conversation');
        expect(conversation.subtitle).toBe('hello');
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
