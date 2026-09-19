import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { FastifyInstance } from 'fastify';
import { AppModule } from '../src/app.module.js';

function makeHome(): { home: string; cleanup: () => void } {
    const base = join(process.cwd(), 'apps/api/node_modules/.mazi-api-test');
    mkdirSync(base, { recursive: true });
    const home = mkdtempSync(join(base, 'home-'));
    writeFileSync(
        join(home, 'providers.json'),
        JSON.stringify({
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
        }),
    );
    writeFileSync(join(home, 'tools.json'), '{"tools":[]}');
    writeFileSync(join(home, 'flags.json'), '{"flags":[]}');
    return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

describe('sessions 中断/恢复端点（IR-E）', () => {
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

    async function createSession(): Promise<string> {
        const created = await fastify.inject({
            method: 'POST',
            url: '/api/sessions',
            headers: { 'content-type': 'application/json' },
            payload: { input: '读取 README.md 并汇报' },
        });
        expect(created.statusCode).toBe(200);
        return created.json().sessionId as string;
    }

    it('POST /api/sessions/:id/stop（空闲）-> 200 { state: idle }', async () => {
        const sessionId = await createSession();
        const res = await fastify.inject({
            method: 'POST',
            url: `/api/sessions/${sessionId}/stop`,
            headers: { 'content-type': 'application/json' },
            payload: '{}',
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ sessionId, state: 'idle' });
    });

    it('POST /api/sessions/:id/resume -> 200 执行并返回 rootGoalId/tasks/ok', async () => {
        const sessionId = await createSession();
        const res = await fastify.inject({
            method: 'POST',
            url: `/api/sessions/${sessionId}/resume`,
            headers: { 'content-type': 'application/json' },
            payload: JSON.stringify({ goal: { modelId: 'faux-model', reasoningLevel: 'high' } }),
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.rootGoalId).toBe(sessionId);
        expect(typeof body.ok).toBe('boolean');
        expect(Array.isArray(body.tasks)).toBe(true);
        expect(body.tasks.length).toBeGreaterThan(0);
    });

    it('run 完成后 stop 回到 idle（幂等）', async () => {
        const sessionId = await createSession();
        const ran = await fastify.inject({
            method: 'POST',
            url: `/api/sessions/${sessionId}/run`,
            headers: { 'content-type': 'application/json' },
            payload: '{}',
        });
        expect(ran.statusCode).toBe(200);
        const stopped = await fastify.inject({
            method: 'POST',
            url: `/api/sessions/${sessionId}/stop`,
            headers: { 'content-type': 'application/json' },
            payload: '{}',
        });
        expect(stopped.statusCode).toBe(200);
        expect(stopped.json().state).toBe('idle');
    });
});
