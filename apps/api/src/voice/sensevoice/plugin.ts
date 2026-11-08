import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { VoiceTranscribeRequest } from '@mazi/libs';
import Logger from '../../common/log.js';
import { SenseVoiceService, VoiceTranscribeError } from './service.js';
import type { SenseVoiceHost, SenseVoiceModelStore } from './types.js';

export interface SenseVoicePluginOptions {
    service?: SenseVoiceService;
    store?: SenseVoiceModelStore;
    host?: SenseVoiceHost;
    logger?: Logger;
    allowRemote?: boolean;
}

const MAX_BODY_BYTES = 20 * 1024 * 1024;

/** /api/voice/*（DSH 方式：整段录音离线转写）。 */
export const voiceSenseVoicePlugin: FastifyPluginAsync<SenseVoicePluginOptions> = async (
    app,
    opts,
) => {
    const logger = opts.logger ?? new Logger('voice');
    let service = opts.service;
    if (!service) {
        if (!opts.store || !opts.host) {
            throw new Error('voiceSenseVoicePlugin 需要 store + host（或注入 service）');
        }
        service = new SenseVoiceService({ store: opts.store, host: opts.host, logger });
    }
    const activeService = service;
    const allowRemote = opts.allowRemote ?? process.env.MAZI_VOICE_ALLOW_REMOTE === '1';

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

    app.get('/api/voice/capabilities', async () => activeService.capabilities());

    app.post<{ Body: VoiceTranscribeRequest }>(
        '/api/voice/asr/transcribe',
        { bodyLimit: MAX_BODY_BYTES },
        async (request, reply) => {
            try {
                return await activeService.transcribe(request.body ?? { audioBase64: '' });
            } catch (error) {
                return mapError(reply, error);
            }
        },
    );
};

function mapError(reply: FastifyReply, error: unknown): FastifyReply {
    if (error instanceof VoiceTranscribeError) {
        return reply.code(error.statusCode).send({
            error: error.message,
            code: error.code,
            retryable: error.retryable,
        });
    }
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(500).send({ error: message, code: 'internal_error', retryable: false });
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
