import { randomBytes, randomUUID } from 'node:crypto';
import {
    type CreateVoiceSessionRequest,
    type CreateVoiceSessionResponse,
    VOICE_DEFAULT_LANGUAGE,
    VOICE_DEFAULT_LIMITS,
    VOICE_DEFAULT_MODEL_ID,
    VOICE_PROTOCOL_VERSION,
    type VoiceCapabilities,
    type VoiceChunkRequest,
    type VoiceChunkResponse,
    type VoiceErrorCode,
    type VoiceLimits,
    type VoiceModelInfo,
} from '@mazi/libs';
import Logger from '../common/log.js';
import { VoiceEngineError, type VoiceEngineHost, type VoiceEngineSession } from './engine.js';
import { findVoiceModel, type VoiceModelStore } from './models.js';

export class VoiceServiceError extends Error {
    constructor(
        readonly statusCode: number,
        readonly code: VoiceErrorCode,
        message: string,
        readonly retryable = false,
    ) {
        super(message);
        this.name = 'VoiceServiceError';
    }
}

interface VoiceSession {
    sessionId: string;
    token: string;
    modelId: string;
    language: string;
    engine: VoiceEngineSession;
    createdAt: number;
    lastAt: number;
    lastSeq: number;
    revision: number;
    text: string;
    bytes: number;
}

export interface VoiceServiceOptions {
    engine: VoiceEngineHost;
    models: VoiceModelStore;
    limits?: Partial<VoiceLimits>;
    logger?: Logger;
    /** 测试可注入时钟。 */
    now?: () => number;
}

/**
 * 语音输入会话编排：
 * - capabilities / 一次性 session token；
 * - HTTP 分块接收 PCM16LE，驱动本机引擎，返回 partial/final；
 * - 限制并发、单条 utterance 时长、chunk 大小与 session 生命周期。
 *
 * 传输层采用 HTTP 分块（而非 WS）以避免额外运行时依赖；协议语义与设计文档一致。
 */
export class VoiceService {
    private readonly sessions = new Map<string, VoiceSession>();
    private readonly limits: VoiceLimits;
    private readonly logger: Logger;
    private readonly now: () => number;
    private readonly cleanupTimer: NodeJS.Timeout;

    constructor(private readonly options: VoiceServiceOptions) {
        this.limits = { ...VOICE_DEFAULT_LIMITS, ...options.limits };
        this.logger = options.logger ?? new Logger('voice');
        this.now = options.now ?? Date.now;
        this.cleanupTimer = setInterval(() => this.cleanup(), 30_000);
        this.cleanupTimer.unref?.();
    }

    capabilities(): VoiceCapabilities {
        const availability = this.options.engine.availability();
        const models = this.options.models.list();
        const defaultModel = findVoiceModel(VOICE_DEFAULT_MODEL_ID);
        const defaultInstalled = defaultModel
            ? this.options.models.installed(defaultModel.id)
            : false;
        const install = this.options.models.autoInstallStatus?.();
        let reason: string | undefined;
        if (!availability.available) {
            reason = availability.reason ?? 'sherpa_unavailable';
        } else if (!defaultInstalled) {
            reason = 'model_missing';
        }
        return {
            version: VOICE_PROTOCOL_VERSION,
            engines: {
                local: {
                    available: availability.available && defaultInstalled,
                    reason,
                    ...(defaultModel ? { modelId: defaultModel.id } : {}),
                },
            },
            models,
            limits: this.limits,
            security: { loopbackOnly: true, secureContextRequired: true },
            ...(install ? { install } : {}),
        };
    }

    models(): VoiceModelInfo[] {
        return this.options.models.list();
    }

    async createSession(input: CreateVoiceSessionRequest): Promise<CreateVoiceSessionResponse> {
        const availability = this.options.engine.availability();
        if (!availability.available) {
            throw new VoiceServiceError(
                503,
                'engine_unavailable',
                availability.reason ?? '本机语音引擎不可用',
                true,
            );
        }
        const modelId = normalizeModelId(input?.modelId);
        const definition = findVoiceModel(modelId);
        if (!definition) {
            throw new VoiceServiceError(400, 'bad_request', `未知模型：${modelId}`);
        }
        if (!this.options.models.installed(modelId)) {
            throw new VoiceServiceError(409, 'model_missing', '语音模型未安装', false);
        }
        if (this.sessions.size >= this.limits.maxSessions) {
            throw new VoiceServiceError(429, 'busy', '语音识别忙，请稍后再试', true);
        }
        const language = normalizeLanguage(input?.language);
        const sessionId = randomUUID();
        const token = randomBytes(24).toString('base64url');
        let engine: VoiceEngineSession;
        try {
            engine = await this.options.engine.open({
                sessionId,
                modelId,
                modelDir: this.options.models.modelDir(modelId),
                language,
                sampleRate: 16000,
            });
        } catch (error) {
            throw mapEngineError(error);
        }
        const now = this.now();
        this.sessions.set(sessionId, {
            sessionId,
            token,
            modelId,
            language,
            engine,
            createdAt: now,
            lastAt: now,
            lastSeq: -1,
            revision: 0,
            text: '',
            bytes: 0,
        });
        this.logger.log(`asr session opened ${sessionId} model=${modelId}`);
        return {
            sessionId,
            token,
            expiresAt: now + this.limits.maxSessionMs,
            limits: this.limits,
        };
    }

    async chunk(input: VoiceChunkRequest): Promise<VoiceChunkResponse> {
        const session = this.requireSession(input?.sessionId, input?.token);
        const now = this.now();
        if (now - session.createdAt > this.limits.maxSessionMs) {
            this.discard(session.sessionId);
            throw new VoiceServiceError(410, 'session_expired', '语音识别会话已过期', true);
        }
        const seq = Number(input?.seq);
        if (!Number.isInteger(seq) || seq < 0) {
            throw new VoiceServiceError(400, 'bad_request', 'seq 非法');
        }
        // 网络重试的幂等语义：旧 seq 直接回放上次结果，不重复喂音频。
        if (seq <= session.lastSeq) {
            return {
                type: 'partial',
                revision: session.revision,
                ...(session.text ? { text: session.text } : {}),
            };
        }
        const pcm = decodePcm(input?.pcmBase64, this.limits.maxChunkBytes);
        if (pcm.length === 0 && input?.end !== true) {
            throw new VoiceServiceError(400, 'bad_request', '空音频块');
        }
        session.bytes += pcm.length;
        if (now - session.lastAt > this.limits.maxUtteranceMs) {
            this.discard(session.sessionId);
            throw new VoiceServiceError(408, 'timeout', '单次语音超过时长上限', true);
        }
        session.lastSeq = seq;
        session.lastAt = now;

        try {
            if (pcm.length > 0) {
                const result = await session.engine.push(pcm);
                if (typeof result.partial === 'string' && result.partial !== session.text) {
                    session.text = result.partial;
                    session.revision += 1;
                }
            }
            if (input?.end === true) {
                const final = await session.engine.end();
                const text = final.text.trim();
                this.discard(session.sessionId);
                this.logger.log(
                    `asr session finished ${session.sessionId} bytes=${session.bytes} chars=${text.length}`,
                );
                return { type: 'final', text, revision: session.revision + 1, done: true };
            }
            return {
                type: 'partial',
                revision: session.revision,
                ...(session.text ? { text: session.text } : {}),
                latencyMs: Math.max(0, this.now() - now),
            };
        } catch (error) {
            this.discard(session.sessionId);
            if (error instanceof VoiceServiceError) throw error;
            throw mapEngineError(error);
        }
    }

    close(): void {
        clearInterval(this.cleanupTimer);
        for (const session of this.sessions.values()) {
            try {
                session.engine.close();
            } catch {
                // 关闭失败不影响进程退出。
            }
        }
        this.sessions.clear();
        this.options.engine.closeAll();
    }

    private requireSession(sessionId: unknown, token: unknown): VoiceSession {
        if (typeof sessionId !== 'string' || typeof token !== 'string') {
            throw new VoiceServiceError(400, 'bad_request', 'sessionId/token 非法');
        }
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new VoiceServiceError(410, 'session_expired', '语音识别会话不存在或已结束', true);
        }
        if (!safeEqual(session.token, token)) {
            throw new VoiceServiceError(401, 'unauthorized', '语音识别 token 非法');
        }
        return session;
    }

    private discard(sessionId: string): void {
        const session = this.sessions.get(sessionId);
        if (!session) return;
        try {
            session.engine.close();
        } catch {
            // ignore
        }
        this.sessions.delete(sessionId);
    }

    private cleanup(): void {
        const now = this.now();
        for (const [sessionId, session] of this.sessions) {
            if (now - session.createdAt > this.limits.maxSessionMs) {
                this.discard(sessionId);
            }
        }
    }
}

function normalizeModelId(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length === 0) return VOICE_DEFAULT_MODEL_ID;
    return value.trim();
}

function normalizeLanguage(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length === 0) return VOICE_DEFAULT_LANGUAGE;
    return value.trim().slice(0, 24);
}

function decodePcm(value: unknown, maxBytes: number): Buffer {
    if (typeof value !== 'string' || value.length === 0) return Buffer.alloc(0);
    // base64 长度上限先粗判，避免为超大输入分配内存。
    if (value.length > Math.ceil((maxBytes * 4) / 3) + 8) {
        throw new VoiceServiceError(413, 'too_large', '音频块过大');
    }
    let buffer: Buffer;
    try {
        buffer = Buffer.from(value, 'base64');
    } catch {
        throw new VoiceServiceError(400, 'bad_request', 'pcmBase64 非法');
    }
    if (buffer.length > maxBytes) {
        throw new VoiceServiceError(413, 'too_large', '音频块过大');
    }
    return buffer;
}

function safeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length) return false;
    // 逐字节比较，避免 token 比较泄露时序。
    let diff = 0;
    for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
    return diff === 0;
}

function mapEngineError(error: unknown): VoiceServiceError {
    if (error instanceof VoiceServiceError) return error;
    if (error instanceof VoiceEngineError) {
        const status =
            error.code === 'model_missing'
                ? 409
                : error.code === 'engine_unavailable'
                  ? 503
                  : error.code === 'busy'
                    ? 429
                    : error.code === 'timeout'
                      ? 504
                      : 502;
        return new VoiceServiceError(status, error.code, error.message, error.retryable);
    }
    const message = error instanceof Error ? error.message : String(error);
    return new VoiceServiceError(502, 'asr_failed', `语音识别失败：${message}`, true);
}
