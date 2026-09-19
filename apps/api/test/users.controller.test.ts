import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestAppHandle } from '../src/testing/test-app.js';

describe('users（用户级行为流与画像简单统计）', () => {
    let h: TestAppHandle;

    beforeAll(async () => {
        h = await createTestApp({ copyDemoConfig: true });
    });

    afterAll(async () => {
        await h.close();
    });

    it('GET /api/users/:id/behaviors 按 userId 聚合；未知用户为空；all 为本机全部', async () => {
        const created = await h.fastify.inject({
            method: 'POST',
            url: '/api/sessions',
            headers: { 'content-type': 'application/json' },
            payload: { input: '读取 README', userId: 'me' },
        });
        const sessionId = created.json().sessionId as string;
        await h.fastify.inject({
            method: 'POST',
            url: `/api/sessions/${sessionId}/feedback`,
            headers: { 'content-type': 'application/json' },
            payload: { type: 'output_rating', rating: 5, content: '好' },
        });

        const mine = await h.fastify.inject({ method: 'GET', url: '/api/users/me/behaviors' });
        expect(mine.statusCode).toBe(200);
        const body = mine.json() as { userId: string; behaviors: Array<{ type: string }> };
        expect(body.userId).toBe('me');
        expect(body.behaviors.map((b) => b.type)).toEqual(['input', 'feedback', 'feedback']);

        const other = await h.fastify.inject({ method: 'GET', url: '/api/users/nobody/behaviors' });
        expect((other.json() as { behaviors: unknown[] }).behaviors).toEqual([]);

        const all = await h.fastify.inject({ method: 'GET', url: '/api/users/all/behaviors' });
        expect((all.json() as { behaviors: unknown[] }).behaviors.length).toBeGreaterThanOrEqual(3);
    });

    it('GET /api/users/:id/profile 返回机械特征简单统计', async () => {
        const res = await h.fastify.inject({ method: 'GET', url: '/api/users/me/profile' });
        expect(res.statusCode).toBe(200);
        const body = res.json() as {
            userId: string;
            behaviorCount: number;
            summary: { questions: number; ratings: number; sufficient: boolean };
            generatedAt: number;
        };
        expect(body.userId).toBe('me');
        expect(body.behaviorCount).toBeGreaterThanOrEqual(3);
        expect(body.summary.questions).toBeGreaterThanOrEqual(1);
        expect(body.summary.ratings).toBeGreaterThanOrEqual(1);
        expect(typeof body.generatedAt).toBe('number');
    });

    it('export / clear / backfill 行为数据治理', async () => {
        const created = await h.fastify.inject({
            method: 'POST',
            url: '/api/sessions',
            headers: { 'content-type': 'application/json' },
            payload: { input: '治理测试', userId: 'gov' },
        });
        const sessionId = created.json().sessionId as string;

        const exported = await h.fastify.inject({
            method: 'GET',
            url: '/api/users/gov/behaviors/export',
        });
        expect(exported.statusCode).toBe(200);
        const exportBody = exported.json() as {
            format: string;
            behaviors: Array<{ type: string }>;
        };
        expect(exportBody.format).toBe('user-behavior-stream');
        expect(exportBody.behaviors.map((b) => b.type)).toEqual(['input']);

        const cleared = await h.fastify.inject({
            method: 'POST',
            url: '/api/users/gov/behaviors/clear',
        });
        expect(cleared.json().cleared).toBeGreaterThanOrEqual(1);
        const afterClear = await h.fastify.inject({ method: 'GET', url: '/api/users/gov/behaviors' });
        expect((afterClear.json() as { behaviors: unknown[] }).behaviors).toEqual([]);

        const backfilled = await h.fastify.inject({
            method: 'POST',
            url: '/api/users/gov/behaviors/backfill',
        });
        expect(backfilled.json().backfilled).toBe(1);
        const afterBackfill = await h.fastify.inject({
            method: 'GET',
            url: '/api/users/gov/behaviors',
        });
        const rows = (afterBackfill.json() as { behaviors: Array<{ type: string; data: Record<string, unknown> }> })
            .behaviors;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ type: 'input', data: { derived: true, text: '治理测试' } });
        expect(sessionId).toBeTruthy();
    });
});
