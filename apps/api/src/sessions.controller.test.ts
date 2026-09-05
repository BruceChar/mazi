import 'reflect-metadata';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { FastifyInstance } from 'fastify';
import { AppModule } from './app.module.js';

/** 独立 MAZI_HOME（含离线 faux 真实驱动配置），避免触碰 ~/.mazi */
function makeHome(): { home: string; cleanup: () => void } {
    const base = join(process.cwd(), 'apps/api/node_modules/.mazi-api-test');
    mkdirSync(base, { recursive: true });
    const home = mkdtempSync(join(base, 'home-'));
    writeFileSync(
        join(home, 'providers.json'),
        JSON.stringify(
            {
                providers: [
                    {
                        id: 'faux',
                        vendor: 'faux',
                        tags: ['tools'],
                        models: [
                            {
                                id: 'faux-model',
                                contextWindow: 64000,
                                supportsTools: true,
                                supportsThinking: true,
                                supportsVision: false,
                            },
                        ],
                        driver: { type: 'pi-ai', provider: 'faux', model: 'faux-model' },
                    },
                ],
            },
            null,
            2,
        ),
    );
    for (const file of ['tools.json', 'flags.json']) {
        writeFileSync(join(home, file), file === 'tools.json' ? '{"tools":[]}' : '{"flags":[]}');
    }
    return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

describe('sessions（NG-2 契约对齐旧 node:http）', () => {
    let app: NestFastifyApplication;
    let fastify: FastifyInstance;
    let cleanup: () => void;

    beforeAll(async () => {
        const made = makeHome();
        cleanup = made.cleanup;
        process.env.MAZI_HOME = made.home;
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
        app.setGlobalPrefix('api');
        await app.init();
        fastify = app.getHttpAdapter().getInstance() as FastifyInstance;
    });

    afterAll(async () => {
        await app?.close();
        cleanup?.();
        delete process.env.MAZI_HOME;
    });

    it('POST /api/sessions 缺 input → 400 { error: "缺少 input" }', async () => {
        const res = await fastify.inject({
            method: 'POST',
            url: '/api/sessions',
            headers: { 'content-type': 'application/json' },
            payload: {},
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: '缺少 input' });
    });

    it('POST /api/sessions + GET 列表 + GET 详情/时间线（契约闭环）', async () => {
        const created = await fastify.inject({
            method: 'POST',
            url: '/api/sessions',
            headers: { 'content-type': 'application/json' },
            payload: { input: '读取 README.md 并汇报' },
        });
        expect(created.statusCode).toBe(200);
        const { sessionId, state } = created.json();
        expect(typeof sessionId).toBe('string');
        expect(state).toBe('running');

        const list = await fastify.inject({ method: 'GET', url: '/api/sessions?limit=100' });
        expect(list.statusCode).toBe(200);
        const items = list.json();
        expect(Array.isArray(items)).toBe(true);
        expect(items.some((i: { sessionId: string }) => i.sessionId === sessionId)).toBe(true);
        const item = items.find((i: { sessionId: string }) => i.sessionId === sessionId);
        expect(item.title).toBe('读取 README.md 并汇报');
        expect(item.input).toBe('读取 README.md 并汇报');

        for (const url of [`/api/sessions/${sessionId}`, `/api/sessions/${sessionId}/timeline`]) {
            const detail = await fastify.inject({ method: 'GET', url });
            expect(detail.statusCode).toBe(200);
            const body = detail.json();
            expect(body.sessionId).toBe(sessionId);
            expect(Array.isArray(body.turns)).toBe(true);
        }
    });

    it('GET /api/sessions/:unknown → 404 { error: "session not found" }', async () => {
        const res = await fastify.inject({
            method: 'GET',
            url: '/api/sessions/01HXZZZZZZZZZZZZZZZZZZZZZZ',
        });
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ error: 'session not found' });
    });

    it('POST /api/sessions/:id/run → 200 执行结果（真实厂商驱动请求链路）', async () => {
        const created = await fastify.inject({
            method: 'POST',
            url: '/api/sessions',
            headers: { 'content-type': 'application/json' },
            payload: { input: '读取 README.md 并汇报' },
        });
        const { sessionId } = created.json();
        const res = await fastify.inject({
            method: 'POST',
            url: `/api/sessions/${sessionId}/run`,
            headers: { 'content-type': 'application/json' },
            payload: '{}',
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.sessionId).toBe(sessionId);
        expect(typeof body.sessionId).toBe('string');
    });

    it('POST /api/run 缺 input → 400；带 input → 200', async () => {
        const missing = await fastify.inject({
            method: 'POST',
            url: '/api/run',
            headers: { 'content-type': 'application/json' },
            payload: {},
        });
        expect(missing.statusCode).toBe(400);
        expect(missing.json()).toEqual({ error: '缺少 input' });

        const ok = await fastify.inject({
            method: 'POST',
            url: '/api/run',
            headers: { 'content-type': 'application/json' },
            payload: { input: '读取 README.md 并汇报' },
        });
        expect(ok.statusCode).toBe(200);
        expect(typeof ok.json().sessionId).toBe('string');
    });
});
