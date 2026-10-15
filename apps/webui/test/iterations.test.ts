import { describe, expect, it, vi } from 'vitest';

(globalThis as any).document = { documentElement: { dataset: {} }, getElementById: () => null };
(globalThis as any).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const calls: Array<{ path: string; method?: string; body?: string }> = [];
vi.mock('../src/api.js', () => ({
    API_BASE: '',
    logApi: () => {},
    api: vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
        calls.push({ path, method: init?.method, body: init?.body });
        if (path === '/api/iterations' && !init?.method) {
            return { iterations: [{ toc: { tocId: 'toc1' }, analyses: [] }] };
        }
        if (path === '/api/iterations/records' && !init?.method) {
            return { records: [{ iterationId: 'it1', title: 't', status: 'proposed' }] };
        }
        if (path === '/api/system/info') {
            return { version: 'v1.0.0', commit: 'abc1234', branch: 'main', dirty: false };
        }
        if (path === '/api/iterations/analyses') {
            return { toc: { tocId: 'toc1' }, analysis: { analyzeId: 'a1', status: 'succeeded' } };
        }
        if (path === '/api/iterations/records' && init?.method === 'POST') {
            return { record: { iterationId: 'it2', title: 'adopted', status: 'proposed' } };
        }
        if (path === '/api/iterations/records/it2' && init?.method === 'PATCH') {
            return { record: { iterationId: 'it2', title: 'adopted', status: 'in_progress' } };
        }
        return { feedback: { feedbackId: 'f1' } };
    }),
}));

vi.mock('vue', () => ({
    ref: (value: unknown) => ({ value }),
    reactive: (value: unknown) => value,
    computed: (fn: () => unknown) => ({
        get value() {
            return fn();
        },
    }),
    watch: () => () => {},
}));

const {
    analyzeToc,
    createIterationRecord,
    iterationRecords,
    iterations,
    loadIterations,
    submitIterationFeedback,
    systemVersion,
    updateIterationRecord,
} = await import('../src/scripts/store.ts');

describe('iterations store', () => {
    it('loadIterations 并行拉取 TOC 聚合 / 迭代记录 / 系统信息', async () => {
        await loadIterations();
        expect(iterations.value).toHaveLength(1);
        expect(iterationRecords.value).toEqual([{ iterationId: 'it1', title: 't', status: 'proposed' }]);
        expect(systemVersion.value).toEqual({
            version: 'v1.0.0',
            commit: 'abc1234',
            branch: 'main',
            dirty: false,
        });
        expect(calls.some((c) => c.path === '/api/iterations')).toBe(true);
        expect(calls.some((c) => c.path === '/api/iterations/records' && !c.method)).toBe(true);
        expect(calls.some((c) => c.path === '/api/system/info')).toBe(true);
    });

    it('analyzeToc POST 并返回 tocId/analyzeId/status', async () => {
        const result = await analyzeToc({ taskId: 't1', rootGoalId: 'r1', userInput: 'audit' });
        expect(result).toEqual({ tocId: 'toc1', analyzeId: 'a1', status: 'succeeded' });
        expect(
            calls.some((c) => c.path === '/api/iterations/analyses' && c.method === 'POST'),
        ).toBe(true);
    });

    it('submitIterationFeedback POST 到 analyzeId 路径', async () => {
        await submitIterationFeedback('a1', { content: 'nice' });
        expect(
            calls.some((c) => c.path === '/api/iterations/a1/feedback' && c.method === 'POST'),
        ).toBe(true);
    });

    it('createIterationRecord POST 采纳报告并回填记录', async () => {
        const record = await createIterationRecord({ title: 'adopted', analyzeId: 'a1', tocId: 'toc1' });
        const call = calls.find((c) => c.path === '/api/iterations/records' && c.method === 'POST');
        expect(call).toBeDefined();
        expect(JSON.parse(call?.body ?? '{}')).toEqual({
            title: 'adopted',
            analyzeId: 'a1',
            tocId: 'toc1',
        });
        expect(record?.iterationId).toBe('it2');
    });

    it('updateIterationRecord PATCH 到记录路径并回填新状态', async () => {
        const record = await updateIterationRecord('it2', { status: 'in_progress' });
        const call = calls.find(
            (c) => c.path === '/api/iterations/records/it2' && c.method === 'PATCH',
        );
        expect(call).toBeDefined();
        expect(JSON.parse(call?.body ?? '{}')).toEqual({ status: 'in_progress' });
        expect(record?.status).toBe('in_progress');
    });
});
