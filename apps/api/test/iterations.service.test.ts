import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { IterationsService } from '../src/iterations/iterations.service.js';

function serviceWith(tocAnalyst: Record<string, unknown>): IterationsService {
    const runtime = { harness: () => ({ tocAnalyst }) };
    return new IterationsService(runtime as never);
}

describe('IterationsService', () => {
    it('list 返回聚合视图', async () => {
        const iterations = [{ toc: { tocId: 'toc1' }, analyses: [] }];
        const service = serviceWith({ listIterations: async () => iterations });
        expect(await service.list()).toEqual({ iterations });
    });

    it('analyze 校验必填并透传字段', async () => {
        const calls: unknown[] = [];
        const service = serviceWith({
            analyze: async (input: unknown) => {
                calls.push(input);
                return { toc: { tocId: 'toc1' }, analysis: { analyzeId: 'a1', status: 'succeeded' } };
            },
        });
        await expect(service.analyze({ rootGoalId: 'r1' })).rejects.toThrow('taskId');
        const result = await service.analyze({
            taskId: 't1',
            goalId: 'g1',
            rootGoalId: 'r1',
            userInput: 'audit',
            modelId: 'm1',
        });
        expect(result.analysis.analyzeId).toBe('a1');
        expect(calls[0]).toEqual({
            taskId: 't1',
            rootGoalId: 'r1',
            goalId: 'g1',
            userInput: 'audit',
            modelId: 'm1',
        });
    });

    it('addFeedback 校验 content 并返回记录', async () => {
        const service = serviceWith({ addFeedback: async () => ({ feedbackId: 'f1' }) });
        await expect(service.addFeedback('a1', {})).rejects.toThrow('content');
        expect(await service.addFeedback('a1', { content: 'nice', rating: 4 })).toEqual({
            feedback: { feedbackId: 'f1' },
        });
    });
});
