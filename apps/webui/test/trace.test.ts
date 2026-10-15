import { describe, expect, it } from 'vitest';
import type { AuditSegment, AuditStepRow, AuditTaskRow } from '../src/scripts/audit.ts';
import {
    TRACE_MIN_BAR_PERCENT,
    buildTraceBoard,
    filterTraceGroups,
} from '../src/scripts/trace.ts';

function segment(over: Partial<AuditSegment> = {}): AuditSegment {
    return {
        key: 'system',
        label: 'system prompt',
        tokens: 400,
        ratio: 0.4,
        colorVar: '--seg-system',
        content: '',
        ...over,
    };
}

function row(over: Partial<AuditStepRow> = {}): AuditStepRow {
    return {
        stepId: 's1',
        lineIndex: 1,
        startedAt: 1000,
        endedAt: 2000,
        runIndex: 1,
        taskIndex: 1,
        index: 1,
        kind: 'deliberation',
        taskId: 't1',
        goalId: 'g1',
        rootGoalId: 'r1',
        toolName: '',
        toolCommand: '',
        toolCwd: '',
        toolLine: '',
        toolOutput: '',
        status: 'succeeded',
        taskStatus: 'succeeded',
        durationMs: 1000,
        tokensPerSecond: 10,
        tokens: 120,
        contextTotal: 1000,
        contextBytes: null,
        contextDelta: null,
        diffContent: '',
        diffParts: [],
        segments: [segment()],
        selected: false,
        ...over,
    };
}

function toolRow(over: Partial<AuditStepRow> = {}): AuditStepRow {
    return row({
        stepId: 'tool1',
        lineIndex: 2,
        index: 2,
        kind: 'invocation',
        toolName: 'shell.run',
        toolCommand: 'ls .',
        toolCwd: '~/.mazi',
        toolLine: '~/.mazi ls .',
        toolOutput: 'a.txt',
        tokens: 0,
        tokensPerSecond: null,
        contextTotal: null,
        segments: [],
        ...over,
    });
}

function task(over: Partial<AuditTaskRow> = {}): AuditTaskRow {
    return {
        taskId: 't1',
        runIndex: 1,
        taskIndex: 1,
        title: '落地核心考虑',
        status: 'succeeded',
        stepCount: 2,
        ...over,
    };
}

describe('buildTraceBoard · KPI 概览', () => {
    it('统计步数 / 模型步 / 工具调用 / 异常', () => {
        const board = buildTraceBoard({
            rows: [
                row({ stepId: 'a' }),
                toolRow({ stepId: 'b' }),
                toolRow({ stepId: 'c', status: 'failed' }),
            ],
        });
        expect(board.summary.steps).toBe(3);
        expect(board.summary.modelSteps).toBe(1);
        expect(board.summary.toolSteps).toBe(2);
        expect(board.summary.errorSteps).toBe(1);
    });

    it('vendor 用量与成本取会话聚合口径', () => {
        const board = buildTraceBoard({
            rows: [row()],
            usage: {
                vendor: { input: 2000, output: 500, cacheRead: 1500 },
                cost: { total: 0.012 },
            },
        });
        expect(board.summary.inputTokens).toBe(2000);
        expect(board.summary.outputTokens).toBe(500);
        expect(board.summary.cacheReadTokens).toBe(1500);
        expect(board.summary.costUsd).toBe(0.012);
    });

    it('缓存命中率 = cacheRead / input；input 为 0 时为 null', () => {
        expect(
            buildTraceBoard({
                rows: [row()],
                usage: { vendor: { input: 2000, output: 1, cacheRead: 1500 }, cost: { total: 0 } },
            }).summary.cacheHitRate,
        ).toBeCloseTo(0.75);
        expect(
            buildTraceBoard({ rows: [row()], usage: { vendor: { input: 0, output: 0, cacheRead: 0 } } })
                .summary.cacheHitRate,
        ).toBeNull();
    });

    it('耗时 = trace 起止跨度；无行时为 null', () => {
        const board = buildTraceBoard({
            rows: [
                row({ stepId: 'a', startedAt: 0, endedAt: 1000, durationMs: 1000 }),
                row({ stepId: 'b', startedAt: 4000, endedAt: 6000, durationMs: 2000 }),
            ],
        });
        expect(board.summary.startedAt).toBe(0);
        expect(board.summary.endedAt).toBe(6000);
        expect(board.summary.durationMs).toBe(6000);

        const empty = buildTraceBoard({ rows: [] });
        expect(empty.summary.durationMs).toBeNull();
        expect(empty.groups).toEqual([]);
        expect(empty.peakContext).toBe(0);
    });
});

describe('buildTraceBoard · 分组与 span 树', () => {
    it('按 Task 分组并带上任务标题', () => {
        const board = buildTraceBoard({
            rows: [
                row({ stepId: 'a', taskId: 't1' }),
                row({ stepId: 'b', taskId: 't2', taskIndex: 2, index: 1 }),
            ],
            tasks: [task(), task({ taskId: 't2', taskIndex: 2, title: '第二个任务' })],
        });
        expect(board.groups.map((g) => g.key)).toEqual(['1:t1', '1:t2']);
        expect(board.groups[0].title).toBe('落地核心考虑');
        expect(board.groups[1].title).toBe('第二个任务');
        expect(board.groups[0].runIndex).toBe(1);
        expect(board.groups[1].taskIndex).toBe(2);
    });

    it('工具调用挂到前一个模型步之下，不作为顶层 span', () => {
        const board = buildTraceBoard({
            rows: [
                row({ stepId: 'a' }),
                toolRow({ stepId: 'b' }),
                toolRow({ stepId: 'c', index: 3 }),
                row({ stepId: 'd', index: 4 }),
            ],
        });
        const spans = board.groups[0].spans;
        expect(spans.map((s) => s.stepId)).toEqual(['a', 'd']);
        expect(spans[0].children.map((s) => s.stepId)).toEqual(['b', 'c']);
        expect(spans[1].children).toEqual([]);
    });

    it('首个模型步之前的工具调用单独成行（lead）', () => {
        const board = buildTraceBoard({
            rows: [toolRow({ stepId: 'a', index: 1 }), row({ stepId: 'b', index: 2 })],
        });
        const spans = board.groups[0].spans;
        expect(spans.map((s) => s.stepId)).toEqual(['a', 'b']);
        expect(spans[0].isTool).toBe(true);
        expect(spans[0].children).toEqual([]);
    });

    it('每个 span 带 R#T#S# 整体编号与类型标签', () => {
        const board = buildTraceBoard({ rows: [row({ runIndex: 2, taskIndex: 3, index: 5 })] });
        const span = board.groups[0].spans[0];
        expect(span.loc).toBe('R#2·T#3·S#5');
        expect(span.kindLabel).toBe('model');
        expect(span.name).toBe('deliberation');
    });

    it('工具 span 的名称优先取工具名', () => {
        const board = buildTraceBoard({ rows: [toolRow()] });
        expect(board.groups[0].spans[0].name).toBe('shell.run');
        expect(board.groups[0].spans[0].kindLabel).toBe('tool');
    });
});

describe('buildTraceBoard · 时间线几何', () => {
    it('按 trace 时间跨度归一 offset 与宽度', () => {
        const board = buildTraceBoard({
            rows: [
                row({ stepId: 'a', startedAt: 0, endedAt: 1000, durationMs: 1000 }),
                row({ stepId: 'b', startedAt: 500, endedAt: 1500, durationMs: 1000, index: 2 }),
            ],
            now: 9999,
        });
        const [a, b] = board.groups[0].spans;
        expect(a.timeline.left).toBeCloseTo(0);
        expect(a.timeline.width).toBeCloseTo(66.67, 1);
        expect(b.timeline.left).toBeCloseTo(33.33, 1);
        expect(b.timeline.width).toBeCloseTo(66.67, 1);
    });

    it('极短 span 有最小可见宽度', () => {
        const board = buildTraceBoard({
            rows: [
                row({ stepId: 'a', startedAt: 0, endedAt: 1000, durationMs: 1000 }),
                row({ stepId: 'b', startedAt: 0, endedAt: 10, durationMs: 10, index: 2 }),
            ],
            now: 9999,
        });
        const b = board.groups[0].spans[1];
        expect(b.timeline.width).toBe(TRACE_MIN_BAR_PERCENT);
    });

    it('执行中的 span 以 now 截断', () => {
        const board = buildTraceBoard({
            rows: [
                row({ stepId: 'a', startedAt: 0, endedAt: 1000, durationMs: 1000 }),
                row({ stepId: 'b', startedAt: 500, endedAt: null, durationMs: null, index: 2 }),
            ],
            now: 1000,
        });
        const b = board.groups[0].spans[1];
        expect(b.timeline.left).toBeCloseTo(50);
        expect(b.timeline.width).toBeCloseTo(50);
    });

    it('单步 trace 不产生除零', () => {
        const board = buildTraceBoard({
            rows: [row({ startedAt: 100, endedAt: 200, durationMs: 100 })],
        });
        const span = board.groups[0].spans[0];
        expect(span.timeline.left).toBe(0);
        expect(span.timeline.width).toBe(100);
    });
});

describe('buildTraceBoard · Context 堆叠条', () => {
    it('按峰值 context 归一宽度', () => {
        const board = buildTraceBoard({
            rows: [
                row({ stepId: 'a', contextTotal: 1000 }),
                row({ stepId: 'b', index: 2, contextTotal: 2000 }),
            ],
        });
        const [a, b] = board.groups[0].spans;
        expect(board.peakContext).toBe(2000);
        expect(a.context.width).toBe(50);
        expect(b.context.width).toBe(100);
        expect(board.latestContext).toBe(2000);
    });

    it('分段宽度按 contextTotal 占比', () => {
        const board = buildTraceBoard({
            rows: [
                row({
                    contextTotal: 1000,
                    segments: [
                        segment({ key: 'system', tokens: 400 }),
                        segment({ key: 'history', label: 'user history', tokens: 600, colorVar: '--seg-user' }),
                    ],
                }),
            ],
        });
        const span = board.groups[0].spans[0];
        expect(span.segments.map((s) => s.width)).toEqual([40, 60]);
    });

    it('工具 span 没有 context 条与分段', () => {
        const board = buildTraceBoard({ rows: [row(), toolRow()] });
        const tool = board.groups[0].spans[0].children[0];
        expect(tool.context.width).toBe(0);
        expect(tool.segments).toEqual([]);
        expect(tool.contextTotal).toBeNull();
    });

    it('透传 context delta 与窗口利用率数据', () => {
        const board = buildTraceBoard({
            rows: [row({ contextDelta: 120 })],
        });
        expect(board.groups[0].spans[0].contextDelta).toBe(120);
    });
});

describe('filterTraceGroups', () => {
    const rows = [
        row({ stepId: 'm1', index: 1 }),
        toolRow({ stepId: 't1', index: 2 }),
        toolRow({ stepId: 't2', index: 3, status: 'failed' }),
        row({ stepId: 'm2', index: 4, status: 'failed' }),
    ];

    it('all 原样返回', () => {
        const board = buildTraceBoard({ rows });
        expect(filterTraceGroups(board.groups, 'all')).toBe(board.groups);
    });

    it('model 只保留模型步，去掉工具子步', () => {
        const board = buildTraceBoard({ rows });
        const groups = filterTraceGroups(board.groups, 'model');
        expect(groups[0].spans.map((s) => s.stepId)).toEqual(['m1', 'm2']);
        expect(groups[0].spans[0].children).toEqual([]);
    });

    it('tool 保留工具步，并保留其父模型步作为容器', () => {
        const board = buildTraceBoard({ rows });
        const groups = filterTraceGroups(board.groups, 'tool');
        expect(groups[0].spans.map((s) => s.stepId)).toEqual(['m1']);
        expect(groups[0].spans[0].children.map((s) => s.stepId)).toEqual(['t1', 't2']);
    });

    it('error 保留异常 span 及其父容器，过滤掉正常 span', () => {
        const board = buildTraceBoard({ rows });
        const groups = filterTraceGroups(board.groups, 'error');
        expect(groups[0].spans.map((s) => s.stepId)).toEqual(['m1', 'm2']);
        expect(groups[0].spans[0].children.map((s) => s.stepId)).toEqual(['t2']);
    });

    it('过滤后没有命中的分组被移除', () => {
        const board = buildTraceBoard({ rows: [row({ stepId: 'ok' })] });
        expect(filterTraceGroups(board.groups, 'error')).toEqual([]);
    });
});
