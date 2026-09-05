import 'reflect-metadata';
import { createTestApp, type TestAppHandle } from './testing/test-app.js';

describe('users & events（NG-3 契约对齐旧 node:http）', () => {
    let h: TestAppHandle;
    let aliceSessionId: string;

    beforeAll(async () => {
        h = await createTestApp({ copyDemoConfig: true });
        const created = await h.fastify.inject({
            method: 'POST',
            url: '/api/sessions',
            headers: { 'content-type': 'application/json' },
            payload: { input: '读取 README.md 并汇报', userId: 'alice' },
        });
        aliceSessionId = created.json().sessionId;
        const ran = await h.fastify.inject({
            method: 'POST',
            url: `/api/sessions/${aliceSessionId}/run`,
            headers: { 'content-type': 'application/json' },
            payload: '{}',
        });
        expect(ran.statusCode).toBe(200);
    });

    afterAll(async () => {
        await h.close();
    });

    it('GET /api/users/alice/profile → 聚合快照字段齐全', async () => {
        const res = await h.fastify.inject({ method: 'GET', url: '/api/users/alice/profile' });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.userId).toBe('alice');
        expect(body.sessions).toBeGreaterThanOrEqual(1);
        expect(typeof body.totalTokens).toBe('number');
        expect(typeof body.totalCostUsd).toBe('number');
        expect(Array.isArray(body.recent)).toBe(true);
        expect(body.recent[0].sessionId).toBe(aliceSessionId);
        expect(typeof body.outcomes).toBe('object');
    });

    it('GET /api/users/nobody/profile → 空用户零值聚合', async () => {
        const res = await h.fastify.inject({ method: 'GET', url: '/api/users/nobody/profile' });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.sessions).toBe(0);
        expect(body.totalTokens).toBe(0);
        expect(body.totalCostUsd).toBe(0);
        expect(body.recent).toEqual([]);
    });

    it('GET /api/events/:id → 事件回放数组（含 session.started），未知会话为 []', async () => {
        const res = await h.fastify.inject({
            method: 'GET',
            url: `/api/events/${aliceSessionId}?limit=5000`,
        });
        expect(res.statusCode).toBe(200);
        const events = res.json();
        expect(Array.isArray(events)).toBe(true);
        expect(events.length).toBeGreaterThan(0);
        expect(events.some((e: { type: string }) => e.type === 'session.started')).toBe(true);

        const unknown = await h.fastify.inject({
            method: 'GET',
            url: '/api/events/01HXZZZZZZZZZZZZZZZZZZZZZZ',
        });
        expect(unknown.statusCode).toBe(200);
        expect(unknown.json()).toEqual([]);
    });
});
