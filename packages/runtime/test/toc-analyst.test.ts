import { describe, expect, it } from 'vitest';
import type { GoalTreeSnapshot, StepView } from '@mazi/libs';
import { MemoryTocStore } from '../src/analysis/toc-store.js';
import { TocAnalyst } from '../src/analysis/toc-analyst.js';
import type { ExecutorRoundContext, RoundResult } from '../src/gts/round-types.js';

function deliberation(stepId: string, startedAt: number, thinking: string, answer = ''): StepView {
    return {
        stepId,
        goalId: 'g1',
        taskId: 't1',
        kind: 'deliberation',
        status: 'succeeded',
        startedAt,
        thinking,
        ...(answer ? { answer } : {}),
    };
}

const snapshot: GoalTreeSnapshot = {
    rootGoalId: 'root',
    taskCount: 1,
    stepCount: 2,
    goals: [
        {
            goalId: 'g1',
            status: 'succeeded',
            statement: 'do the thing',
            tasks: [
                {
                    taskId: 't1',
                    title: 'task',
                    status: 'succeeded',
                    steps: [
                        deliberation('d1', 1, 'first thought'),
                        {
                            stepId: 'i1',
                            goalId: 'g1',
                            taskId: 't1',
                            kind: 'invocation',
                            status: 'succeeded',
                            startedAt: 2,
                            toolName: 'shell.run',
                            toolArguments: { command: 'ls' },
                            toolOutput: '',
                        },
                        deliberation('d2', 3, 'second thought', 'final answer'),
                    ],
                },
            ],
        },
    ],
};

const okRound: RoundResult = {
    text: 'ANALYSIS OUTPUT',
    reasoning: '',
    toolCalls: [],
    finishReason: 'stop',
    ttftMs: 0,
    totalMs: 1,
};

function analyst(store: MemoryTocStore, round: RoundResult = okRound) {
    return new TocAnalyst({
        store,
        snapshotOf: async () => snapshot,
        requestRound: async (_rootGoalId: string, _ctx: ExecutorRoundContext) => round,
        resolveModelChoice: () => ({ providerId: 'p', modelId: 'm' }),
        now: () => 100,
    });
}

describe('TocAnalyst（TOC 冻结 + 独立分析 + 反馈）', () => {
    it('冻结 thinking 链为 toc，并记录分析输出/模型/时间', async () => {
        const store = new MemoryTocStore();
        const { toc, analysis } = await analyst(store).analyze({
            taskId: 't1',
            goalId: 'g1',
            rootGoalId: 'root',
            userInput: '审计这条链',
        });
        expect(toc.text).toContain('1. first thought');
        expect(toc.text).toContain('2. second thought');
        expect(toc.text).toContain('final answer');
        expect(toc.userInput).toBe('审计这条链');
        expect(toc.model).toEqual({ providerId: 'p', modelId: 'm' });
        expect(analysis.status).toBe('succeeded');
        expect(analysis.output).toBe('ANALYSIS OUTPUT');
        expect(analysis.tocId).toBe(toc.tocId);
        expect(analysis.endedAt).toBe(100);
        expect(await store.loadToc(toc.tocId)).toBeDefined();
    });

    it('同一 toc 可多次分析（1 对多），tocId 复用时不重新冻结', async () => {
        const store = new MemoryTocStore();
        const sut = analyst(store);
        const first = await sut.analyze({
            taskId: 't1',
            goalId: 'g1',
            rootGoalId: 'root',
            userInput: 'round 1',
        });
        const second = await sut.analyze({
            taskId: 't1',
            goalId: 'g1',
            rootGoalId: 'root',
            userInput: 'round 2',
            tocId: first.toc.tocId,
        });
        expect(second.toc.tocId).toBe(first.toc.tocId);
        const iterations = await sut.listIterations();
        expect(iterations).toHaveLength(1);
        expect(iterations[0]?.analyses).toHaveLength(2);
        expect(iterations[0]?.analyses.map((a) => a.userInput)).toEqual(['round 1', 'round 2']);
    });

    it('分析失败落 failed + error，不抛穿；反馈按 analyzeId 关联', async () => {
        const store = new MemoryTocStore();
        const failing = new TocAnalyst({
            store,
            snapshotOf: async () => snapshot,
            requestRound: async () => {
                throw new Error('provider down');
            },
            resolveModelChoice: () => undefined,
            now: () => 7,
        });
        const { analysis } = await failing.analyze({
            taskId: 't1',
            goalId: 'g1',
            rootGoalId: 'root',
            userInput: 'audit',
        });
        expect(analysis.status).toBe('failed');
        expect(analysis.error).toBe('provider down');

        await failing.addFeedback(analysis.analyzeId, { content: 'great point', rating: 5 });
        const iterations = await failing.listIterations();
        const feedback = iterations[0]?.analyses[0]?.feedback ?? [];
        expect(feedback).toHaveLength(1);
        expect(feedback[0]?.content).toBe('great point');
        expect(feedback[0]?.rating).toBe(5);
    });
});
