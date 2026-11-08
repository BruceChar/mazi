import 'reflect-metadata';
import { resolve } from 'node:path';
import { ensureExecutablePath } from '@mazi/runtime';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import dotenv from 'dotenv';
import type { FastifyInstance } from 'fastify';
import { AppModule } from './app.module.js';
import { registerHttpLogging } from './common/http-log.js';
import Logger from './common/log.js';
import { SenseVoiceHost } from './voice/sensevoice/host.js';
import { voiceSenseVoicePlugin } from './voice/sensevoice/plugin.js';
import { SenseVoiceStore } from './voice/sensevoice/store.js';

// 配置源：包内 .env（apps/api/.env）优先，仓库根 .env 兜底；
// 两者均不覆盖进程已存在的环境变量（shell/CI 注入优先，dotenv 默认语义）。
dotenv.config({ path: resolve(import.meta.dirname, '../../.env'), quiet: true });
dotenv.config({ path: resolve(import.meta.dirname, '../../../.env'), quiet: true });

const logger = new Logger('main');

/** 端口/跨域/监听地址环境变量与旧 node:http 实现一致（前端/冒烟脚本透明） */
const PORT = Number.parseInt(process.env.MAZI_SERVER_PORT ?? '6294', 10);
/** 监听地址：默认 0.0.0.0（IPv4 全接口），保证 localhost 与 127.0.0.1 均可访问 */
const HOST = process.env.MAZI_SERVER_HOST ?? '0.0.0.0';
/** CORS：默认反射请求 Origin（值合法且带凭据安全）；显式 MAZI_CORS_ORIGIN 可覆盖为具体站点 */
const CORS_ORIGIN = process.env.MAZI_CORS_ORIGIN ?? true;

async function bootstrap(): Promise<void> {
    // 内置 CLI 工具（rg/fd/xh…）按名字 execFile，继承本进程 PATH；从 Finder/launchd 启动时
    // PATH 常缺 /opt/homebrew/bin，会表现成「grep 能用、rg 不能用」。启动期补齐，幂等。
    const addedPathDirs = ensureExecutablePath();
    if (addedPathDirs.length > 0) logger.log(`PATH 补齐: ${addedPathDirs.join('、')}`);

    const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
        logger: false,
    });
    app.setGlobalPrefix('api');

    // HTTP 访问日志：方法/路径/状态码/耗时（/api/health 轮询在 http-log 内过滤，不写日志）
    const fastify = app.getHttpAdapter().getInstance() as FastifyInstance;
    registerHttpLogging(fastify, { logger });

    app.enableCors({
        origin: CORS_ORIGIN,
        methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['content-type'],
    });
    // 语音输入：DSH 方式（SenseVoiceSmall + Silero VAD，整段录音后离线转写）。
    const voiceStore = new SenseVoiceStore({ logger });
    const voiceHost = new SenseVoiceHost({ store: voiceStore, logger });
    // 服务启动即自动安装/复用本机模型；MAZI_VOICE_AUTO_INSTALL=0 可关闭（离线/CI）。
    if (process.env.MAZI_VOICE_AUTO_INSTALL !== '0') {
        void installDefaultVoiceModel(voiceStore, logger);
    }
    await fastify.register(voiceSenseVoicePlugin, {
        store: voiceStore,
        host: voiceHost,
        logger,
    });

    app.enableShutdownHooks();

    await app.listen(PORT, HOST);
    logger.log(`mazi running on ${process.env.NODE_ENV}:${HOST}:${PORT}`);
    logger.debug(`MAZI_HOME=${process.env.MAZI_HOME}`);
}

void bootstrap();

/** 启动时自动安装默认语音模型（后台重试，不阻塞 API 启动）。 */
async function installDefaultVoiceModel(store: SenseVoiceStore, log: Logger): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            const status = await store.ensureInstalled();
            if (!status) return;
            if (status.status === 'done') {
                log.log('voice model ready (auto-installed)');
                return;
            }
            log.warn(
                `voice model auto-install failed (attempt ${attempt}/3): ${status.error ?? 'unknown'}`,
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log.warn(`voice model auto-install failed (attempt ${attempt}/3): ${message}`);
        }
        if (attempt < 3) {
            await new Promise((resolve) => setTimeout(resolve, attempt * 5_000));
        }
    }
}
