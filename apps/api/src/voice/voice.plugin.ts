import type { CreateVoiceSessionRequest, VoiceChunkRequest, VoiceLimits } from '@mazi/libs';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import Logger from '../common/log.js';
import type { VoiceEngineHost } from './engine.js';
import { VoiceModelError } from './model-manager.js';
import type { VoiceModelStore } from './models.js';
import { VoiceService, VoiceServiceError } from './voice.service.js';

export interface VoicePluginOptions {
    /** 测试可注入完整的 service。 */
    service?: VoiceService;
    engine?: VoiceEngineHost;
    models?: VoiceModelStore;
    limits?: Partial<VoiceLimits>;
    logger?: Logger;
    /** 默认仅 loopback；显式开启需配合反向代理认证。 */
    allowRemote?: boolean;
}

const MAX_BODY_BYTES = 256 * 1024;

/** 注册 /api/voice/* 路由（裸 Fastify 路由；Nest 的 globalPrefix 不作用于这里）。 */
export const voicePlugin: FastifyPluginAsync<VoicePluginOptions> = async (app, opts) => {
    const logger = opts.logger ?? new Logger('voice');
    let service = opts.service;
    if (!service) {
        if (!opts.engine || !opts.models) {
            throw new Error('voicePlugin 需要 engine + models（或注入 service）');
        }
        service = new VoiceService({
            engine: opts.engine,
            models: opts.models,
            ...(opts.limits ? { limits: opts.limits } : {}),
            logger,
        });
    }
    const modelStore = opts.models;
    const allowRemote = opts.allowRemote ?? process.env.MAZI_VOICE_ALLOW_REMOTE === '1';
    const activeService = service;

    app.addHook('onClose', async () => {
        activeService.close();
    });

    app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
        if (!request.url.startsWith('/api/voice/')) return;
        if (!allowRemote && !isLoopback(request)) {
            return reply.code(403).send({
                error: '语音输入仅允许本机访问',
                code: 'forbidden',
                retryable: false,
            });
        }
        if (!originAllowed(request)) {
            return reply.code(403).send({
                error: '语音输入的 Origin 不被允许',
                code: 'forbidden',
                retryable: false,
            });
        }
    });

    app.get('/api/voice/capabilities', async () => {
        return activeService.capabilities();
    });

    app.get('/api/voice/models', async () => {
        return { models: activeService.models() };
    });

    app.post<{ Body: CreateVoiceSessionRequest }>(
        '/api/voice/asr/sessions',
        { bodyLimit: MAX_BODY_BYTES },
        async (request, reply) => {
            return handle(reply, () => activeService.createSession(request.body ?? {}));
        },
    );

    app.post<{ Body: VoiceChunkRequest }>(
        '/api/voice/asr/chunk',
        { bodyLimit: MAX_BODY_BYTES },
        async (request, reply) => {
            return handle(reply, () => activeService.chunk(request.body));
        },
    );

    app.post<{ Params: { id: string } }>(
        '/api/voice/models/:id/download',
        async (request, reply) => {
            if (!modelStore) {
                return reply.code(503).send({
                    error: '模型管理不可用',
                    code: 'engine_unavailable',
                    retryable: false,
                });
            }
            return handle(reply, () => {
                const job = modelStore.startDownload(request.params.id);
                logger.log(`model download started ${request.params.id} job=${job.jobId}`);
                return job;
            });
        },
    );

    app.get<{ Params: { jobId: string } }>(
        '/api/voice/models/downloads/:jobId',
        async (request, reply) => {
            if (!modelStore) {
                return reply.code(503).send({
                    error: '模型管理不可用',
                    code: 'engine_unavailable',
                    retryable: false,
                });
            }
            const status = modelStore.downloadStatus(request.params.jobId);
            if (!status) {
                return reply.code(404).send({
                    error: '下载任务不存在',
                    code: 'not_found',
                    retryable: false,
                });
            }
            return status;
        },
    );

    app.delete<{ Params: { id: string } }>('/api/voice/models/:id', async (request, reply) => {
        if (!modelStore?.remove) {
            return reply.code(503).send({
                error: '模型管理不可用',
                code: 'engine_unavailable',
                retryable: false,
            });
        }
        return handle(reply, () => {
            modelStore.remove?.(request.params.id);
            return { ok: true };
        });
    });
};

async function handle<T>(
    reply: FastifyReply,
    run: () => Promise<T> | T,
): Promise<T | FastifyReply> {
    try {
        return await run();
    } catch (error) {
        const mapped = toServiceError(error);
        return reply.code(mapped.statusCode).send({
            error: mapped.message,
            code: mapped.code,
            retryable: mapped.retryable,
        });
    }
}

function toServiceError(error: unknown): VoiceServiceError {
    if (error instanceof VoiceServiceError) return error;
    if (error instanceof VoiceModelError) {
        const statusCode =
            error.code === 'not_found'
                ? 404
                : error.code === 'bad_request'
                  ? 400
                  : error.code === 'engine_unavailable'
                    ? 503
                    : 500;
        return new VoiceServiceError(statusCode, error.code, error.message, error.retryable);
    }
    const message = error instanceof Error ? error.message : String(error);
    return new VoiceServiceError(500, 'internal_error', message, false);
}

export function isLoopback(request: FastifyRequest): boolean {
    const address = normalizeAddress(request.socket.remoteAddress);
    return address === '127.0.0.1' || address === '::1';
}

export function originAllowed(request: FastifyRequest): boolean {
    const origin = request.headers.origin;
    if (typeof origin !== 'string' || origin.length === 0) return true;
    let parsed: URL;
    try {
        parsed = new URL(origin);
    } catch {
        return false;
    }
    // 本机 UI（Vite dev / serve）允许任意 loopback 端口；生产同源要求 Host 一致。
    if (
        parsed.hostname === 'localhost' ||
        parsed.hostname === '127.0.0.1' ||
        parsed.hostname === '::1'
    ) {
        return true;
    }
    const host = request.headers.host;
    return typeof host === 'string' && parsed.host === host;
}

function normalizeAddress(address: string | undefined): string {
    if (!address) return '';
    if (address.startsWith('::ffff:')) return address.slice('::ffff:'.length);
    return address;
}
