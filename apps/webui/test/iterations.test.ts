import { describe, expect, it, vi } from 'vitest';

(globalThis as any).document = { documentElement: { dataset: {} }, getElementById: () => null };
(globalThis as any).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const calls: Array<{ path: string; method?: string }> = [];
vi.mock('../src/api.js', () => ({
    API_BASE: '',
    logApi: () => {},
    api: vi.fn(async (path: string, init?: { method?: string }) => {
        calls.push({ path, method: init?.method });
        if (path === '/api/iterations' && !init?.method) {
            return { iterations: [{ toc: { tocId: 'toc1' }, analyses: [] }] };
        }
        if (path === '/api/iterations/analyses') {
            return { toc: { tocId: 'toc1' }, analysis: { analyzeId: 'a1', status: 'succeeded' } };
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

const { analyzeToc, iterations, loadIterations, submitIterationFeedback } = await import(
    '../src/scripts/store.ts'
);

describe('iterations store', () => {
    it('loadIterations 拉取聚合视图', async () => {
        await loadIterations();
        expect(iterations.value).toHaveLength(1);
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
});
