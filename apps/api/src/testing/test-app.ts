import 'reflect-metadata';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { FastifyInstance } from 'fastify';
import { AppModule } from '../app.module.js';

const DEMO_CONFIG = join(process.cwd(), 'apps/cli/config');

export interface TestAppHandle {
    app: NestFastifyApplication;
    fastify: FastifyInstance;
    home: string;
    close: () => Promise<void>;
}

/**
 * 装配测试用 Nest 应用：MAZI_HOME 指向工作区内独立临时目录（不触碰 ~/.mazi）；
 * copyDemoConfig 时写入 scripted 演示 providers/tools/flags，供真实执行链路测试。
 */
export async function createTestApp(
    options: { copyDemoConfig?: boolean } = {},
): Promise<TestAppHandle> {
    const base = join(process.cwd(), 'apps/api/node_modules/.mazi-api-test');
    mkdirSync(base, { recursive: true });
    const home = mkdtempSync(join(base, 'home-'));
    if (options.copyDemoConfig) {
        for (const file of ['providers.json', 'tools.json', 'flags.json']) {
            copyFileSync(join(DEMO_CONFIG, file), join(home, file));
        }
    }
    process.env.MAZI_HOME = home;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    await app.init();
    const fastify = app.getHttpAdapter().getInstance() as FastifyInstance;
    return {
        app,
        fastify,
        home,
        close: async () => {
            await app.close();
            rmSync(home, { recursive: true, force: true });
            delete process.env.MAZI_HOME;
        },
    };
}
