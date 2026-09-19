import { beforeEach, describe, expect, it, vi } from 'vitest';

// 浏览器桩必须在 import store 之前就位（api.ts 在模块加载时读 location.search）。
const stubEl = () => ({
    style: {},
    dataset: {},
    setAttribute: () => {},
    appendChild: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    click: () => {},
});
(globalThis as any).location = { search: '' };
(globalThis as any).document = {
    documentElement: { dataset: {} },
    body: { appendChild: () => {} },
    getElementById: () => null,
    createElement: () => stubEl(),
    createTextNode: () => ({}),
    addEventListener: () => {},
    removeEventListener: () => {},
};
(globalThis as any).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const calls: string[] = [];

function stubFetch(payloads: Record<string, unknown>): void {
    (globalThis as any).fetch = vi.fn(async (url: string) => {
        calls.push(String(url));
        const key = Object.keys(payloads).find((candidate) => String(url).includes(candidate));
        return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => (key ? payloads[key] : {}),
        };
    });
}

const {
    addQuestionLabels,
    backfillUserBehaviors,
    clearUserBehaviors,
    exportUserBehaviors,
    fetchLedger,
    fetchQuestionTaxonomy,
    fetchUserBehaviors,
    fetchUserProfile,
    fetchUserQuestions,
} = await import('../src/scripts/store.ts');

describe('个人中心数据获取（GET /api/users|ledger）', () => {
    beforeEach(() => {
        calls.length = 0;
    });

    it('fetchUserBehaviors：解析 behaviors，缺失回落 []', async () => {
        stubFetch({
            '/api/users/all/behaviors': {
                userId: 'all',
                behaviors: [{ ts: 1, type: 'input', data: { text: 'q' } }],
            },
        });
        expect(await fetchUserBehaviors('all')).toHaveLength(1);
        expect(calls[0]).toContain('/api/users/all/behaviors');

        stubFetch({});
        expect(await fetchUserBehaviors('all')).toEqual([]);
    });

    it('fetchUserProfile：透传画像视图字段', async () => {
        stubFetch({
            '/api/users/me/profile': {
                userId: 'me',
                behaviorCount: 3,
                summary: { total: 3 },
                generatedAt: 1,
            },
        });
        const profile = await fetchUserProfile('me');
        expect(profile.behaviorCount).toBe(3);
        expect(calls[0]).toContain('/api/users/me/profile');
    });

    it('export/backfill/clear 调用治理端点并解析计数', async () => {
        stubFetch({
            '/api/users/all/behaviors/backfill': { backfilled: 12 },
            '/api/users/all/behaviors/clear': { cleared: 12 },
            '/api/users/all/behaviors/export': {
                format: 'user-behavior-stream',
                schemaVersion: '2.0',
                subject: { id: 'all' },
                behaviors: [{ ts: 1, type: 'input', data: { text: 'q' } }],
            },
        });
        expect(await backfillUserBehaviors('all')).toBe(12);
        expect(await clearUserBehaviors('all')).toBe(12);
        const exported = await exportUserBehaviors('all');
        expect(exported.format).toBe('user-behavior-stream');
        expect(exported.behaviors).toHaveLength(1);
        expect(calls.some((url) => url.includes('/behaviors/backfill'))).toBe(true);
        expect(calls.some((url) => url.includes('/behaviors/clear'))).toBe(true);
    });

    it('fetchUserQuestions / addQuestionLabels / taxonomy', async () => {
        stubFetch({
            '/api/users/all/questions': {
                userId: 'all',
                questions: [
                    {
                        questionId: 'q1',
                        ts: 1,
                        text: 'q',
                        derived: false,
                        sessionId: 's',
                        createdAt: 1,
                        labels: [],
                        effective: { speech_act: ['question'] },
                    },
                ],
            },
            '/api/questions/q1/labels': { questionId: 'q1', effective: { domain: ['growth'] } },
            '/api/question-taxonomy': { version: 1, speechAct: ['question'], domains: {} },
        });
        const questions = await fetchUserQuestions('all', { type: 'question', q: 'q' });
        expect(questions).toHaveLength(1);
        expect(calls[0]).toContain('type=question');

        const updated = await addQuestionLabels('q1', [
            { axis: 'domain', label: 'growth', source: 'user' },
        ]);
        expect(updated.effective.domain).toEqual(['growth']);

        const taxonomy = await fetchQuestionTaxonomy();
        expect(taxonomy.speechAct).toContain('question');
    });

    it('fetchLedger：拼 kind/limit 并解析 entries', async () => {
        stubFetch({
            '/api/ledger': {
                entries: [{ failureId: 'f1', sessionId: 's1', kind: 'driver-error', createdAt: 1 }],
            },
        });
        const entries = await fetchLedger({ kind: 'driver-error', limit: 5 });
        expect(entries).toHaveLength(1);
        expect(calls[0]).toContain('kind=driver-error');
        expect(calls[0]).toContain('limit=5');
    });
});
