import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { SessionsService } from '../src/sessions/sessions.service.js';

/** FeatureRuntime 空替身：无开关 = 无运行级覆盖（SessionsService 现在也读全局 Feature）。 */
const noFeatures = {
    features: async () => ({
        resolve: () => ({
            values: {},
            trace: [],
            enabledIds: [],
            promptFragment: '',
            skillIds: [],
            skillMode: 'inherit',
        }),
    }),
    skills: async () => ({ mounted: () => [] }),
};


describe('SessionsService 中断/恢复（IR-E）', () => {
    it('stopSession：命中在跑运行 -> stopping；空闲 -> idle', () => {
        let running = true;
        const runtime = {
            ...noFeatures,
            harness: () => ({ stopGoalTree: () => running }),
        };
        const service = new SessionsService(runtime as never, {} as never);
        expect(service.stopSession('s1')).toEqual({ sessionId: 's1', state: 'stopping' });
        running = false;
        expect(service.stopSession('s1')).toEqual({ sessionId: 's1', state: 'idle' });
    });

    it('resumeSession：透传 model/reasoning，经串行锁调用 resumeGoalTree', async () => {
        const calls: Array<{ id: string; options: Record<string, unknown> }> = [];
        const runtime = {
            ...noFeatures,
            runExclusive: async (operation: () => Promise<unknown>) => operation(),
            harness: () => ({
                resumeGoalTree: async (id: string, options: Record<string, unknown>) => {
                    calls.push({ id, options });
                    return { rootGoalId: id, tasks: [], ok: true };
                },
            }),
        };
        const service = new SessionsService(runtime as never, {} as never);
        const result = await service.resumeSession('s1', {
            goal: { modelId: 'm1', reasoningLevel: 'high' },
        });
        expect(result.rootGoalId).toBe('s1');
        expect(calls).toEqual([{ id: 's1', options: { reasoningLevel: 'high', modelId: 'm1' } }]);
    });

    it('resumeSession：无 goal 覆盖时不传 model/reasoning', async () => {
        const calls: Array<Record<string, unknown>> = [];
        const runtime = {
            ...noFeatures,
            runExclusive: async (operation: () => Promise<unknown>) => operation(),
            harness: () => ({
                resumeGoalTree: async (_id: string, options: Record<string, unknown>) => {
                    calls.push(options);
                    return { rootGoalId: 's1', tasks: [], ok: true };
                },
            }),
        };
        const service = new SessionsService(runtime as never, {} as never);
        await service.resumeSession('s1', {});
        expect(calls).toEqual([{}]);
    });
});