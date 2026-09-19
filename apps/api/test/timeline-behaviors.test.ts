import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestAppHandle } from '../src/testing/test-app.js';

describe('timeline 用户行为指令（UB-D）', () => {
    let h: TestAppHandle;

    beforeAll(async () => {
        h = await createTestApp({ copyDemoConfig: true });
    });

    afterAll(async () => {
        await h.close();
    });

    it('GET /api/sessions/:id/timeline 返回 behaviors（input + feedback）', async () => {
        const created = await h.fastify.inject({
            method: 'POST',
            url: '/api/sessions',
            headers: { 'content-type': 'application/json' },
            payload: { input: '读取 README.md 并汇报' },
        });
        const sessionId = created.json().sessionId as string;

        await h.fastify.inject({
            method: 'POST',
            url: '/api/sessions/' + sessionId + '/feedback',
            headers: { 'content-type': 'application/json' },
            payload: { type: 'output_rating', rating: 5, content: '不错' },
        });

        const res = await h.fastify.inject({
            method: 'GET',
            url: '/api/sessions/' + sessionId + '/timeline',
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as {
            behaviors?: Array<{ type: string; data: Record<string, unknown> }>;
        };
        expect(body.behaviors?.map((b) => b.type)).toEqual(['input', 'feedback', 'feedback']);
        expect(body.behaviors?.[0]?.data.text).toBe('读取 README.md 并汇报');
    });
});
