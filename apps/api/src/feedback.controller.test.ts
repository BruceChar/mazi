import 'reflect-metadata';
import { createTestApp, type TestAppHandle } from './testing/test-app.js';

describe('feedback（NG-5 契约对齐旧 node:http）', () => {
    let h: TestAppHandle;

    beforeAll(async () => {
        h = await createTestApp({ copyDemoConfig: true });
    });

    afterAll(async () => {
        await h.close();
    });

    it('POST /api/sessions/:id/feedback → { ok:true }，事件回放含 user.feedback.captured', async () => {
        const created = await h.fastify.inject({
            method: 'POST',
            url: '/api/sessions',
            headers: { 'content-type': 'application/json' },
            payload: { input: '读取 README.md 并汇报' },
        });
        const sessionId = created.json().sessionId;

        const res = await h.fastify.inject({
            method: 'POST',
            url: `/api/sessions/${sessionId}/feedback`,
            headers: { 'content-type': 'application/json' },
            payload: { type: 'output_rating', rating: 5, content: '很满意' },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ ok: true });

        const events = await h.fastify.inject({
            method: 'GET',
            url: `/api/events/${sessionId}`,
        });
        const captured = events
            .json()
            .find((e: { type: string }) => e.type === 'user.feedback.captured');
        expect(captured).toBeDefined();
        expect(captured.payload.feedback.rating).toBe(5);
        expect(captured.payload.feedback.content).toBe('很满意');
        expect(captured.payload.feedback.type).toBe('output_rating');
    });

    it('未知 type 回落 output_rating；缺 content/rating 可空', async () => {
        const created = await h.fastify.inject({
            method: 'POST',
            url: '/api/sessions',
            headers: { 'content-type': 'application/json' },
            payload: { input: 'hello' },
        });
        const sessionId = created.json().sessionId;
        const res = await h.fastify.inject({
            method: 'POST',
            url: `/api/sessions/${sessionId}/feedback`,
            headers: { 'content-type': 'application/json' },
            payload: { type: 'mystery' },
        });
        expect(res.statusCode).toBe(200);
        const events = await h.fastify.inject({
            method: 'GET',
            url: `/api/events/${sessionId}`,
        });
        const captured = events
            .json()
            .find((e: { type: string }) => e.type === 'user.feedback.captured');
        expect(captured.payload.feedback.type).toBe('output_rating');
    });
});
