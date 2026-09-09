import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import { AppModule } from './app.module.js';
import Logger from './common/log.js';
import dotenv from 'dotenv';
import { resolve } from 'node:path';

// 配置源：包内 .env（apps/api/.env）优先，仓库根 .env 兜底；
// 两者均不覆盖进程已存在的环境变量（shell/CI 注入优先，dotenv 默认语义）。
dotenv.config({ path: resolve(import.meta.dirname, '../../.env'), quiet: true });
dotenv.config({ path: resolve(import.meta.dirname, '../../../.env'), quiet: true });

const logger = new Logger('main');

/** 端口/跨域/监听地址环境变量与旧 node:http 实现一致（前端/冒烟脚本透明） */
const PORT = Number.parseInt(
    process.env.MAZI_SERVER_PORT ?? '6294',
    10,
);
/** 监听地址：默认 0.0.0.0（IPv4 全接口），保证 localhost 与 127.0.0.1 均可访问 */
const HOST = process.env.MAZI_SERVER_HOST ?? '0.0.0.0';
/** CORS：默认反射请求 Origin（值合法且带凭据安全）；显式 MAZI_CORS_ORIGIN 可覆盖为具体站点 */
const CORS_ORIGIN = process.env.MAZI_CORS_ORIGIN ?? true;

async function bootstrap(): Promise<void> {
    const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
        logger: false,
    });
    app.setGlobalPrefix('api');

    // HTTP 访问日志：方法/路径/状态码/耗时
    const fastify = app.getHttpAdapter().getInstance() as FastifyInstance;
    const withStart = (req: object & { start?: number }): number => {
        req.start = Date.now();
        return req.start;
    };
    fastify.addHook('onRequest', (req, _reply, done) => {
        withStart(req as object & { start?: number });
        done();
    });
    fastify.addHook('onResponse', (req, reply, done) => {
        const started = (req as { start?: number }).start ?? Date.now();
        const ms = Date.now() - started;
        logger.log(`[api] ${reply.statusCode} ${req.method} ${req.url} ${ms}ms`);
        done();
    });

    app.enableCors({
        origin: CORS_ORIGIN,
        methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['content-type'],
    });
    app.enableShutdownHooks();
    await app.listen(PORT, HOST);
    logger.log(`mazi running on ${process.env.NODE_ENV}:${HOST}:${PORT}`);
    logger.debug(`MAZI_HOME=${process.env.MAZI_HOME}`);

}

void bootstrap();
