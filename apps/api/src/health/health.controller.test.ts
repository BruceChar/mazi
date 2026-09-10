import 'reflect-metadata';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerHttpLogging } from '../common/http-log.js';
import Logger from '../common/log.js';
import { createTestApp, type TestAppHandle } from '../testing/test-app.js';

describe('health（独立健康检查接口）', () => {
    let handle: TestAppHandle;
    let fastify: FastifyInstance;
    let captured = '';

    beforeAll(async () => {
        handle = await createTestApp();
        fastify = handle.fastify;
        // 挂载访问日志钩子（捕获到内存流），供日志过滤断言使用
        const stream = new Writable({
            write(chunk, _enc, cb) {
                captured += String(chunk);
                cb();
            },
        });
        registerHttpLogging(fastify, { logger: new Logger('test', stream) });
    });

    afterAll(async () => {
        await handle?.close();
    });

    it('GET /api/health 返回 ok=true 及运行状态', async () => {
        const res = await fastify.inject({ method: 'GET', url: '/api/health' });
        expect(res.statusCode).toBe(200);
        const body = res.json() as { ok?: boolean; busy?: boolean };
        expect(body.ok).toBe(true);
        expect(typeof body.busy).toBe('boolean');
    });

    it('访问日志过滤 /api/health，其他请求正常记录', async () => {
        await fastify.inject({ method: 'GET', url: '/api/health' });
        await fastify.inject({ method: 'GET', url: '/api/config' });

        expect(captured).toContain('/api/config');
        expect(captured).not.toContain('/api/health');
    });
});
