import 'reflect-metadata';
import type { SystemVersionRef } from '@mazi/libs';
import { describe, expect, it } from 'vitest';
import { IterationsService } from '../src/iterations/iterations.service.js';
import type { SystemService } from '../src/system/system.service.js';

const VERSION: SystemVersionRef = {
    version: 'v1.0.0',
    commit: 'abc1234',
    branch: 'main',
    dirty: false,
};

function serviceWith(
    tocAnalyst: Record<string, unknown>,
    iterationTracker: Record<string, unknown> = {},
    version: SystemVersionRef = VERSION,
): IterationsService {
    const runtime = { harness: () => ({ tocAnalyst, iterationTracker }) };
    const system = { readVersion: () => version } as unknown as SystemService;
    return new IterationsService(runtime as never, system);
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

    it('listRecords 返回倒序记录', async () => {
        const records = [{ iterationId: 'it1' }, { iterationId: 'it2' }];
        const service = serviceWith({}, { list: async () => records });
        expect(await service.listRecords()).toEqual({ records });
    });

    it('createRecord 校验 title 必填与长度', async () => {
        const service = serviceWith({}, { create: async () => ({ iterationId: 'it1' }) });
        await expect(service.createRecord({})).rejects.toThrow('缺少 title');
        await expect(service.createRecord({ title: '   ' })).rejects.toThrow('缺少 title');
        await expect(service.createRecord({ title: 'x'.repeat(201) })).rejects.toThrow('title 过长');
    });

    it('createRecord trim 标题并注入当前版本快照', async () => {
        const calls: unknown[] = [];
        const service = serviceWith(
            {},
            {
                create: async (input: unknown) => {
                    calls.push(input);
                    return { iterationId: 'it1', ...(input as Record<string, unknown>) };
                },
            },
        );
        const result = await service.createRecord({
            title: '  收敛 TOC 提示词 ',
            intent: ' 减少冗余输出 ',
            analyzeId: 'a1',
            tocId: 't1',
        });
        expect(calls[0]).toEqual({
            title: '收敛 TOC 提示词',
            intent: '减少冗余输出',
            analyzeId: 'a1',
            tocId: 't1',
            base: VERSION,
        });
        expect(result.record.iterationId).toBe('it1');
    });

    it('createRecord 缺省可选字段时不写入', async () => {
        const calls: unknown[] = [];
        const service = serviceWith(
            {},
            {
                create: async (input: unknown) => {
                    calls.push(input);
                    return { iterationId: 'it1' };
                },
            },
        );
        await service.createRecord({ title: 't' });
        expect(calls[0]).toEqual({ title: 't', base: VERSION });
    });

    it('updateRecord 拒绝非法状态', async () => {
        const service = serviceWith({}, { update: async () => ({ iterationId: 'it1' }) });
        await expect(service.updateRecord('it1', { status: 'bogus' })).rejects.toThrow('无效状态');
    });

    it('updateRecord applied 状态注入当前版本快照', async () => {
        const calls: unknown[] = [];
        const service = serviceWith(
            {},
            {
                update: async (_id: string, patch: unknown) => {
                    calls.push(patch);
                    return { iterationId: 'it1', status: 'applied' };
                },
            },
        );
        await service.updateRecord('it1', { status: 'applied' });
        expect(calls[0]).toEqual({ status: 'applied', applied: VERSION });
    });

    it('updateRecord 透传 title/intent/notes（notes 可清空）', async () => {
        const calls: unknown[] = [];
        const service = serviceWith(
            {},
            {
                update: async (_id: string, patch: unknown) => {
                    calls.push(patch);
                    return { iterationId: 'it1' };
                },
            },
        );
        await service.updateRecord('it1', { title: ' 新标题 ', intent: '新意图', notes: '' });
        expect(calls[0]).toEqual({ title: '新标题', intent: '新意图', notes: '' });
    });

    it('updateRecord 未知 id → 404，非法迁移 → 400', async () => {
        const missing = serviceWith(
            {},
            {
                update: async () => {
                    throw new Error('iteration not found: it9');
                },
            },
        );
        await expect(missing.updateRecord('it9', { notes: 'x' })).rejects.toMatchObject({
            statusCode: 404,
        });

        const illegal = serviceWith(
            {},
            {
                update: async () => {
                    throw new Error('invalid transition: proposed -> applied');
                },
            },
        );
        await expect(
            illegal.updateRecord('it1', { status: 'applied' }),
        ).rejects.toMatchObject({
            statusCode: 400,
            message: 'invalid transition: proposed -> applied',
        });
    });
});
