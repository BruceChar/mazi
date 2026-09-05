import 'reflect-metadata';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { FastifyInstance } from 'fastify';
import { AppModule } from './app.module.js';

/** 在可写的工作区 node_modules 下建独立 MAZI_HOME，避免触碰 ~/.mazi */
function testHome(): string {
    const root = join(process.cwd(), 'apps/api/node_modules/.mazi-api-test');
    mkdirSync(root, { recursive: true });
    try {
        return mkdtempSync(join(root, 'home-'));
    } catch {
        const fallback = join(process.cwd(), 'apps/api/.mazi-api-test');
        mkdirSync(fallback, { recursive: true });
        return mkdtempSync(join(fallback, 'home-'));
    }
}

describe('health & config（NG-1 契约对齐旧 node:http）', () => {
    let app: NestFastifyApplication;
    let fastify: FastifyInstance;
    let home: string;
    let leftover: string[] = [];

    beforeAll(async () => {
        home = testHome();
        leftover = [home];
        process.env.MAZI_HOME = home;
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
        app.setGlobalPrefix('api');
        await app.init();
        fastify = app.getHttpAdapter().getInstance() as FastifyInstance;
    });

    afterAll(async () => {
        await app?.close();
        for (const dir of leftover) {
            rmSync(dir, { recursive: true, force: true });
        }
        delete process.env.MAZI_HOME;
    });

    it('GET /api/health → 200 { ok:true, storage.driver:sqlite, providers:[] }', async () => {
        const res = await fastify.inject({ method: 'GET', url: '/api/health' });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.ok).toBe(true);
        expect(body.busy).toBe(false);
        expect(body.storage.driver).toBe('sqlite');
        expect(body.storage.home).toBe(home);
        expect(body.storage.db).toBe(join(home, 'mazi.db'));
        expect(Array.isArray(body.providers)).toBe(true);
    });

    it('GET /api/config → 200 { defaultConfigDir: home, storage.{driver,db,events} }', async () => {
        const res = await fastify.inject({ method: 'GET', url: '/api/config' });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.defaultConfigDir).toBe(home);
        expect(body.home).toBe(home);
        expect(body.storage.driver).toBe('sqlite');
        expect(body.storage.events).toBe(join(home, 'events'));
        expect(body.hasProvidersFile).toBe(false);
    });

    it('未匹配路由 → 404 { error: "not found" }', async () => {
        const res = await fastify.inject({ method: 'GET', url: '/api/definitely-not-a-route' });
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ error: 'not found' });
    });
});
