import { canTransition, ITERATION_STATUSES } from '@mazi/libs';
import { describe, expect, it } from 'vitest';
import type {
    IterationRecordView,
    IterationStatus,
    TocAnalysisView,
    TocIterationView,
    TocRecordView,
} from '../src/types.ts';
import {
    ITERATION_STATUS_LABELS,
    ITERATION_STATUS_ORDER,
    analysisDurationMs,
    buildIterationBoard,
    filterRecords,
    filterTocs,
    iterationActions,
    iterationStatusTone,
    tocStatusOf,
    versionDetail,
    versionLabel,
} from '../src/scripts/iterations-view.ts';

function toc(over: Partial<TocRecordView> = {}): TocRecordView {
    return {
        tocId: 'toc-aaaaaaaaaaaa',
        taskId: 'task-bbbbbbbb',
        goalId: 'goal-1',
        rootGoalId: 'root-1',
        userInput: '帮我审计这段上下文装配逻辑',
        model: { providerId: 'deepseek', modelId: 'deepseek-chat' },
        text: 'thinking chain text',
        createdAt: 1000,
        ...over,
    };
}

function analysis(over: Partial<TocAnalysisView> = {}): TocAnalysisView {
    return {
        analyzeId: 'an-1',
        tocId: 'toc-aaaaaaaaaaaa',
        userInput: 'audit for defects',
        model: { providerId: 'deepseek', modelId: 'deepseek-chat' },
        status: 'succeeded',
        output: '# 报告\n- 问题一',
        createdAt: 2000,
        endedAt: 2600,
        feedback: [],
        ...over,
    };
}

function iteration(over: Partial<TocIterationView> = {}): TocIterationView {
    return { toc: toc(), analyses: [analysis()], ...over };
}

function record(over: Partial<IterationRecordView> = {}): IterationRecordView {
    return {
        iterationId: 'it-1',
        title: '收敛 TOC 提示词',
        intent: '把分析结论变成系统改动',
        status: 'proposed',
        base: { version: 'abc1234', commit: 'abc1234', branch: 'main', dirty: false },
        notes: '',
        createdAt: 3000,
        updatedAt: 3000,
        ...over,
    };
}

describe('buildIterationBoard · TOC 行', () => {
    it('标题取输入首行，副标题为 task 短号 · 模型', () => {
        const board = buildIterationBoard({ iterations: [iteration()], records: [] });
        const row = board.tocs[0];
        expect(row.title).toBe('帮我审计这段上下文装配逻辑');
        expect(row.subtitle).toBe('task-bbb · deepseek-chat');
        expect(row.shortId).toBe('toc-aaaa');
        expect(row.modelLabel).toBe('deepseek-chat');
    });

    it('没有输入时标题回落 TOC 短 id', () => {
        const board = buildIterationBoard({
            iterations: [iteration({ toc: toc({ userInput: '   ' }) })],
            records: [],
        });
        expect(board.tocs[0].title).toBe('TOC toc-aaaa');
    });

    it('长输入截断到 64 字符', () => {
        const board = buildIterationBoard({
            iterations: [iteration({ toc: toc({ userInput: 'x'.repeat(120) }) })],
            records: [],
        });
        expect(board.tocs[0].title).toHaveLength(64);
        expect(board.tocs[0].title.endsWith('…')).toBe(true);
    });

    it('聚合状态取最新一次分析；无分析为 none', () => {
        const failed = analysis({ analyzeId: 'an-1', status: 'failed', createdAt: 2000 });
        const ok = analysis({ analyzeId: 'an-2', status: 'succeeded', createdAt: 3000 });
        const board = buildIterationBoard({
            iterations: [iteration({ analyses: [failed, ok] }), iteration({ toc: toc({ tocId: 't2' }), analyses: [] })],
            records: [],
        });
        expect(board.tocs[0].status).toBe('succeeded');
        expect(board.tocs[1].status).toBe('none');
        expect(board.tocs[0].latestAt).toBe(3000);
    });

    it('分析倒序（最新在前）并带耗时', () => {
        const first = analysis({ analyzeId: 'an-1', createdAt: 2000, endedAt: 2500 });
        const second = analysis({ analyzeId: 'an-2', createdAt: 3000, endedAt: 3900 });
        const board = buildIterationBoard({
            iterations: [iteration({ analyses: [first, second] })],
            records: [],
        });
        const rows = board.tocs[0].analyses;
        expect(rows.map((r) => r.analysis.analyzeId)).toEqual(['an-2', 'an-1']);
        expect(rows[0].durationMs).toBe(900);
    });
});

describe('buildIterationBoard · 迭代记录', () => {
    it('已采纳标记绑定到对应分析', () => {
        const adopted = record({ analyzeId: 'an-1' });
        const board = buildIterationBoard({
            iterations: [iteration()],
            records: [adopted],
        });
        expect(board.tocs[0].adopted).toBe(true);
        expect(board.tocs[0].analyses[0].record?.iterationId).toBe('it-1');
        expect(board.counts.records).toBe(1);
    });

    it('未采纳时记录为空且不计入', () => {
        const board = buildIterationBoard({ iterations: [iteration()], records: [] });
        expect(board.tocs[0].adopted).toBe(false);
        expect(board.tocs[0].analyses[0].record).toBeNull();
    });

    it('来源标签为 TOC 短 id · 第 N 次分析', () => {
        const second = analysis({ analyzeId: 'an-2', createdAt: 4000 });
        const board = buildIterationBoard({
            iterations: [iteration({ analyses: [analysis(), second] })],
            records: [record({ analyzeId: 'an-2' })],
        });
        expect(board.records[0].sourceLabel).toBe('TOC toc-aaaa · 第 2 次分析');
        expect(board.records[0].tocId).toBe('toc-aaaaaaaaaaaa');
        expect(board.records[0].tocShortId).toBe('toc-aaaa');
    });

    it('来源缺失时标签为空', () => {
        const board = buildIterationBoard({
            iterations: [iteration()],
            records: [record({ analyzeId: undefined })],
        });
        expect(board.records[0].sourceLabel).toBe('');
        expect(board.records[0].tocId).toBe('');
        expect(board.records[0].tocShortId).toBe('');
    });

    it('记录按 updatedAt 倒序，计数按状态归并', () => {
        const board = buildIterationBoard({
            iterations: [iteration()],
            records: [
                record({ iterationId: 'a', updatedAt: 10 }),
                record({ iterationId: 'b', updatedAt: 30, status: 'applied' }),
                record({ iterationId: 'c', updatedAt: 20, status: 'rejected' }),
            ],
        });
        expect(board.records.map((r) => r.record.iterationId)).toEqual(['b', 'c', 'a']);
        expect(board.counts.byStatus).toEqual({
            proposed: 1,
            in_progress: 0,
            applied: 1,
            reverted: 0,
            rejected: 1,
        });
    });

    it('空输入不抛错', () => {
        const board = buildIterationBoard({ iterations: [], records: [] });
        expect(board.tocs).toEqual([]);
        expect(board.records).toEqual([]);
        expect(board.counts).toEqual({
            tocs: 0,
            analyses: 0,
            records: 0,
            byStatus: { proposed: 0, in_progress: 0, applied: 0, reverted: 0, rejected: 0 },
        });
    });
});

describe('filterTocs', () => {
    const rows = buildIterationBoard({
        iterations: [
            iteration({
                toc: toc({ tocId: 'toc-1', taskId: 'task-alpha', userInput: '上下文裁剪', text: 'needle in chain' }),
                analyses: [analysis({ analyzeId: 'an-1', status: 'succeeded' })],
            }),
            iteration({
                toc: toc({ tocId: 'toc-2', taskId: 'task-beta', userInput: '工具重试策略', text: 'other' }),
                analyses: [analysis({ analyzeId: 'an-2', status: 'failed', createdAt: 5000 })],
            }),
            iteration({ toc: toc({ tocId: 'toc-3', userInput: '还没分析过' }), analyses: [] }),
        ],
        records: [],
    }).tocs;

    it('默认全量', () => {
        expect(filterTocs(rows)).toHaveLength(3);
    });

    it('关键字匹配输入 / 思维链原文 / taskId', () => {
        expect(filterTocs(rows, { query: '裁剪' }).map((r) => r.tocId)).toEqual(['toc-1']);
        expect(filterTocs(rows, { query: 'needle' }).map((r) => r.tocId)).toEqual(['toc-1']);
        expect(filterTocs(rows, { query: 'task-beta' }).map((r) => r.tocId)).toEqual(['toc-2']);
    });

    it('关键字大小写不敏感', () => {
        expect(filterTocs(rows, { query: 'NEEDLE' })).toHaveLength(1);
    });

    it('状态过滤（成功 / 失败 / 未分析）', () => {
        expect(filterTocs(rows, { status: 'succeeded' }).map((r) => r.tocId)).toEqual(['toc-1']);
        expect(filterTocs(rows, { status: 'failed' }).map((r) => r.tocId)).toEqual(['toc-2']);
        expect(filterTocs(rows, { status: 'none' }).map((r) => r.tocId)).toEqual(['toc-3']);
    });

    it('状态与关键字同时生效', () => {
        expect(filterTocs(rows, { status: 'failed', query: '裁剪' })).toEqual([]);
    });
});

describe('filterRecords', () => {
    const rows = buildIterationBoard({
        iterations: [iteration()],
        records: [
            record({ iterationId: 'a', status: 'proposed' }),
            record({ iterationId: 'b', status: 'applied' }),
        ],
    }).records;

    it('all 原样返回', () => {
        expect(filterRecords(rows, 'all')).toBe(rows);
    });

    it('按状态过滤', () => {
        expect(filterRecords(rows, 'applied').map((r) => r.record.iterationId)).toEqual(['b']);
        expect(filterRecords(rows, 'reverted')).toEqual([]);
    });
});

describe('状态机动作与展示元信息', () => {
    it('每个状态的合法动作与目标状态', () => {
        expect(iterationActions('proposed').map((a) => [a.action, a.next])).toEqual([
            ['start', 'in_progress'],
            ['reject', 'rejected'],
        ]);
        expect(iterationActions('in_progress').map((a) => [a.action, a.next])).toEqual([
            ['apply', 'applied'],
            ['reject', 'rejected'],
        ]);
        expect(iterationActions('applied').map((a) => [a.action, a.next])).toEqual([
            ['revert', 'reverted'],
        ]);
        expect(iterationActions('reverted').map((a) => [a.action, a.next])).toEqual([
            ['start', 'in_progress'],
        ]);
        expect(iterationActions('rejected').map((a) => [a.action, a.next])).toEqual([
            ['reopen', 'proposed'],
        ]);
    });

    it('UI 动作不偏离 @mazi/libs 的权威状态机（防前后端漂移）', () => {
        for (const status of ITERATION_STATUSES) {
            for (const action of iterationActions(status)) {
                expect(canTransition(status, action.next)).toBe(true);
            }
        }
        expect(ITERATION_STATUS_ORDER).toEqual([...ITERATION_STATUSES]);
        for (const status of ITERATION_STATUSES) {
            expect(ITERATION_STATUS_LABELS[status]).toBeTruthy();
        }
    });

    it('动作带展示文案与色调', () => {
        const [start, reject] = iterationActions('proposed');
        expect(start.label).toBe('开始迭代');
        expect(start.tone).toBe('primary');
        expect(reject.label).toBe('驳回');
        expect(reject.tone).toBe('default');
        expect(iterationActions('applied')[0].tone).toBe('danger');
    });

    it('状态色调', () => {
        expect(iterationStatusTone('applied')).toBe('ok');
        expect(iterationStatusTone('in_progress')).toBe('run');
        expect(iterationStatusTone('reverted')).toBe('warn');
        expect(iterationStatusTone('rejected')).toBe('bad');
        expect(iterationStatusTone('proposed')).toBe('');
    });
});

describe('格式化辅助', () => {
    it('versionLabel 优先提交短号，dirty 加星，全空为 —', () => {
        expect(
            versionLabel({ version: 'v1.0.0-3-gabc1234', commit: 'abc1234', branch: 'main', dirty: false }),
        ).toBe('abc1234');
        expect(
            versionLabel({ version: 'v1.0.0', commit: 'abc1234', branch: 'main', dirty: true }),
        ).toBe('abc1234*');
        expect(versionLabel({ version: '0.0.0', commit: '', branch: '', dirty: false })).toBe('0.0.0');
        expect(versionLabel(null)).toBe('—');
        expect(versionLabel({ version: '', commit: '', branch: '', dirty: false })).toBe('—');
    });

    it('versionDetail 组合版本号与分支（不重复短号）', () => {
        expect(
            versionDetail({ version: 'v1.0.0-3-gabc1234', commit: 'abc1234', branch: 'main', dirty: false }),
        ).toBe('v1.0.0-3-gabc1234 · main');
        expect(
            versionDetail({ version: 'abc1234', commit: 'abc1234', branch: 'main', dirty: false }),
        ).toBe('main');
        expect(versionDetail(null)).toBe('');
    });

    it('analysisDurationMs 处理缺失与负值', () => {
        expect(analysisDurationMs(analysis({ createdAt: 100, endedAt: 200 }))).toBe(100);
        expect(analysisDurationMs(analysis({ endedAt: undefined }))).toBeNull();
        expect(analysisDurationMs(analysis({ createdAt: 300, endedAt: 100 }))).toBeNull();
    });

    it('tocStatusOf 取最后一次分析状态', () => {
        expect(tocStatusOf([])).toBe('none');
        expect(
            tocStatusOf([
                analysis({ status: 'failed' }),
                analysis({ analyzeId: 'an-2', status: 'running' }),
            ]),
        ).toBe('running');
    });
});
