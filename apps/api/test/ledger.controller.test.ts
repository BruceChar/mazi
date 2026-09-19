import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestAppHandle } from '../src/testing/test-app.js';

describe('ledger（失败分类账只读接口）', () => {
    let h: TestAppHandle;

    beforeAll(async () => {
        h = await createTestApp({ copyDemoConfig: true });
    });

    afterAll(async () => {
        await h.close();
    });

    it('任务失败后 GET /api/ledger 返回条目，支持 kind 过滤与 limit', async () => {
        const created = await h.fastify.inject({
            method: 'POST',
            url: '/api/sessions',
            headers: { 'content-type': 'application/json' },
            payload: { input: '会失败的会话', userId: 'me' },
        });
        const sessionId = created.json().sessionId as string;
        const run = await h.fastify.inject({ method: 'POST', url: `/api/sessions/${sessionId}/run` });
        expect(run.statusCode).toBe(200);

        const res = await h.fastify.inject({ method: 'GET', url: '/api/ledger' });
        expect(res.statusCode).toBe(200);
        const entries = (res.json() as { entries: Array<Record<string, unknown>> }).entries;
        expect(entries.length).toBeGreaterThanOrEqual(1);
        expect(entries[0]).toMatchObject({ sessionId, kind: expect.any(String) });

        const filtered = await h.fastify.inject({
            method: 'GET',
            url: '/api/ledger?kind=driver-error&limit=5',
        });
        expect(Array.isArray((filtered.json() as { entries: unknown[] }).entries)).toBe(true);
    });
});
