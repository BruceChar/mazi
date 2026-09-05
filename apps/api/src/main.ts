import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';

/** 端口/跨域环境变量与旧 node:http 实现一致（前端/冒烟脚本透明） */
const PORT = Number.parseInt(
    process.env.MAZI_SERVER_PORT ?? process.env.MAZI_WEB_PORT ?? '4317',
    10,
);
const CORS_ORIGIN = process.env.MAZI_CORS_ORIGIN ?? '*';

async function bootstrap(): Promise<void> {
    const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
        logger: false,
    });
    app.setGlobalPrefix('api');
    app.enableCors({
        origin: CORS_ORIGIN,
        methods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: ['content-type'],
    });
    app.enableShutdownHooks();
    await app.listen(PORT);
    process.stdout.write(
        `mazi api (nestjs + fastify) 已启动： http://127.0.0.1:${PORT} （MAZI_HOME=${process.env.MAZI_HOME ?? '~/.mazi'}）\n`,
    );
}

void bootstrap();
