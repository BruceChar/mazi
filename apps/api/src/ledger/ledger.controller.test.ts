import 'reflect-metadata';
import type { FastifyInstance } from 'fastify';
import { createTestApp, type TestAppHandle } from '../testing/test-app.js';

describe('ledger（失败分类账）', () => {
    let handle: TestAppHandle;
    let fastify: FastifyInstance;

    beforeAll(async () => {
        handle = await createTestApp({ copyDemoConfig: true });
        fastify = handle.fastify;
    });

    afterAll(async () => {
        await handle?.close();
    });

    it('GET /api/ledger 返回分类账数组（初始为空）', async () => {
        const res = await fastify.inject({ method: 'GET', url: '/api/ledger?limit=10' });
        expect(res.statusCode).toBe(200);
        expect(Array.isArray(res.json())).toBe(true);
    });
});
