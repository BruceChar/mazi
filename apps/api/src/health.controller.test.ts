import 'reflect-metadata';
import { join } from 'node:path';
import { createTestApp, type TestAppHandle } from './testing/test-app.js';

describe('health & config（NG-1 契约对齐旧 node:http）', () => {
    let h: TestAppHandle;

    beforeAll(async () => {
        h = await createTestApp();
    });

    afterAll(async () => {
        await h.close();
    });

    it('GET /api/health → 200 { ok:true, storage.driver:sqlite, providers:[] }', async () => {
        const res = await h.fastify.inject({ method: 'GET', url: '/api/health' });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.ok).toBe(true);
        expect(body.busy).toBe(false);
        expect(body.storage.driver).toBe('sqlite');
        expect(body.storage.home).toBe(h.home);
        expect(body.storage.db).toBe(join(h.home, 'mazi.db'));
        expect(Array.isArray(body.providers)).toBe(true);
    });

    it('GET /api/config → 200 { defaultConfigDir: home, storage.{driver,db,events} }', async () => {
        const res = await h.fastify.inject({ method: 'GET', url: '/api/config' });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.defaultConfigDir).toBe(h.home);
        expect(body.home).toBe(h.home);
        expect(body.storage.driver).toBe('sqlite');
        expect(body.storage.events).toBe(join(h.home, 'events'));
        expect(body.hasProvidersFile).toBe(false);
    });

    it('未匹配路由 → 404 { error: "not found" }', async () => {
        const res = await h.fastify.inject({
            method: 'GET',
            url: '/api/definitely-not-a-route',
        });
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ error: 'not found' });
    });
});
