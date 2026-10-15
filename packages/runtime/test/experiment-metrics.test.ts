import { describe, expect, it } from 'vitest';
import type { GoalTreeSnapshot } from '@mazi/libs';
import { collectMetrics, failedMetrics } from '../src/experiment/metrics.js';

function snapshotWith(steps: unknown[]): GoalTreeSnapshot {
    return {
        rootGoalId: 'run-1',
        taskCount: 1,
        stepCount: steps.length,
        goals: [
            {
                goalId: 'run-1',
                status: 'succeeded',
                statement: 's',
                tasks: [{ taskId: 't1', status: 'succeeded', title: 'T', steps }],
            },
        ],
    } as unknown as GoalTreeSnapshot;
}

describe('collectMetrics（口径与 Trace 看板一致）', () => {
    it('按 roundId 去重一轮一次；tokens/cost/ttft 取首轮；最终输出取末个 deliberation', () => {
        const usage = (roundId: string, input: number, output: number, cost: number, ttft: number) => ({
            roundId,
            raw: { modelId: 'm1', inputTokens: input, outputTokens: output, cachedInputTokens: 1 },
            cost: { totalCostUsd: cost },
            timing: { ttftMs: ttft },
        });
        const metrics = collectMetrics({
            snapshot: snapshotWith([
                {
                    stepId: 's1',
                    kind: 'deliberation',
                    status: 'succeeded',
                    content: '第一轮',
                    usage: usage('r1', 10, 5, 0.001, 40),
                },
                {
                    stepId: 's2',
                    kind: 'deliberation',
                    status: 'succeeded',
                    content: '第二轮',
                    answer: '最终答案',
                    usage: usage('r2', 20, 7, 0.002, 90),
                },
                { stepId: 's3', kind: 'invocation', status: 'succeeded', content: 'ok' },
            ]),
            ok: true,
            startedAt: 1000,
            endedAt: 1500,
            skills: ['sk'],
            features: { concise: true },
        });
        expect(metrics).toMatchObject({
            ok: true,
            status: 'succeeded',
            tasks: 1,
            steps: 3,
            toolCalls: 1,
            modelRounds: 2,
            inputTokens: 30,
            outputTokens: 12,
            cachedInputTokens: 2,
            ttftMs: 40,
            durationMs: 500,
            finalAnswer: '最终答案',
            finalAnswerChars: 4,
            models: ['m1'],
            skills: ['sk'],
            features: { concise: true },
        });
        expect(metrics.costUsd).toBeCloseTo(0.003, 12);
    });

    it('停止原因为 aborted → status=aborted；无 usage 不报错', () => {
        const metrics = collectMetrics({
            snapshot: snapshotWith([{ stepId: 's1', kind: 'deliberation', status: 'aborted' }]),
            ok: false,
            reason: 'aborted',
            startedAt: 0,
            endedAt: 10,
            skills: [],
            features: {},
        });
        expect(metrics.status).toBe('aborted');
        expect(metrics.inputTokens).toBe(0);
        expect(metrics.models).toEqual([]);
    });

    it('failedMetrics 兜底：保留错误文本与臂配置，便于仍做对照', () => {
        const metrics = failedMetrics('模型不可用', { skills: ['s'], features: { x: true } });
        expect(metrics.ok).toBe(false);
        expect(metrics.status).toBe('failed');
        expect(metrics.finalAnswer).toBe('模型不可用');
        expect(metrics.skills).toEqual(['s']);
    });
});
