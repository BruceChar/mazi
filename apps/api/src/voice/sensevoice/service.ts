import {
    VOICE_PROTOCOL_VERSION,
    VOICE_DEFAULT_LIMITS,
    VOICE_DEFAULT_LANGUAGE,
    type VoiceCapabilities,
    type VoiceErrorCode,
    type VoiceLimits,
    type VoiceModelInfo,
    type VoiceTranscribeRequest,
    type VoiceTranscribeResponse,
} from '@mazi/libs';
import Logger from '../../common/log.js';
import type {
    SenseVoiceHost,
    SenseVoiceModelStore,
    SenseVoiceTranscribeResult,
} from './types.js';

/** 5 分钟 16kHz mono PCM ≈ 9.6MB，base64 后约 12.8MB。 */
export const VOICE_MAX_AUDIO_BYTES = 16 * 1024 * 1024;

export class VoiceTranscribeError extends Error {
    constructor(
        readonly statusCode: number,
        readonly code: VoiceErrorCode,
        message: string,
        readonly retryable = false,
    ) {
        super(message);
        this.name = 'VoiceTranscribeError';
    }
}

export interface SenseVoiceServiceOptions {
    host: SenseVoiceHost;
    store: SenseVoiceModelStore;
    limits?: Partial<VoiceLimits>;
    logger?: Logger;
}

/**
 * DSH 方式的本机语音转写：整段 PCM16 上传 → SenseVoice + Silero VAD 离线识别。
 * 不做流式 partial，不做自动发送；一次请求返回整段文字。
 */
export class SenseVoiceService {
    private readonly limits: VoiceLimits;
    private readonly logger: Logger;

    constructor(private readonly options: SenseVoiceServiceOptions) {
        this.limits = { ...VOICE_DEFAULT_LIMITS, ...options.limits };
        this.logger = options.logger ?? new Logger('voice');
    }

    capabilities(): VoiceCapabilities {
        const availability = this.options.host.availability();
        const installed = this.options.store.installed();
        const install = this.options.store.installStatus();
        let reason: string | undefined;
        if (!availability.available) {
            reason = availability.reason ?? 'engine_unavailable';
        } else if (!installed) {
            reason = 'model_missing';
        }
        const model = this.options.store.modelInfo();
        return {
            version: VOICE_PROTOCOL_VERSION,
            engines: {
                local: {
                    available: availability.available && installed,
                    reason,
                    modelId: model.id,
                },
            },
            models: [model],
            limits: {
                ...this.limits,
                // 整段上传不再有“单 utterance 30s”的流式限制；保留字段兼容契约。
                maxUtteranceMs: 5 * 60_000,
                maxSessionMs: 5 * 60_000,
            },
            security: { loopbackOnly: true, secureContextRequired: true },
            ...(install ? { install } : {}),
        };
    }

    models(): VoiceModelInfo[] {
        return [this.options.store.modelInfo()];
    }

    async transcribe(input: VoiceTranscribeRequest): Promise<VoiceTranscribeResponse> {
        const availability = this.options.host.availability();
        if (!availability.available) {
            throw new VoiceTranscribeError(
                503,
                availability.reason === 'model_missing' ? 'model_missing' : 'engine_unavailable',
                availability.reason === 'model_missing'
                    ? '本机语音模型尚未就绪，请稍候'
                    : '本机语音引擎不可用',
                true,
            );
        }
        if (!this.options.store.installed()) {
            throw new VoiceTranscribeError(409, 'model_missing', '本机语音模型尚未安装完成', true);
        }
        const pcm = decodeAudio(input?.audioBase64);
        if (pcm.length < 2) {
            throw new VoiceTranscribeError(400, 'bad_request', '音频为空');
        }
        if (pcm.length % 2 !== 0) {
            throw new VoiceTranscribeError(400, 'bad_request', 'PCM16 音频长度必须为偶数');
        }
        const sampleRate = Number(input?.sampleRate ?? 16000);
        if (sampleRate !== 16000) {
            throw new VoiceTranscribeError(400, 'bad_request', '仅支持 16kHz 单声道 PCM16');
        }
        const language = normalizeLanguage(input?.language);
        let result: SenseVoiceTranscribeResult;
        try {
            result = await this.options.host.transcribe({ pcm, sampleRate, language });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new VoiceTranscribeError(502, 'asr_failed', `语音识别失败：${message}`, true);
        }
        const text = result.text.trim();
        this.logger.log(
            `transcribe bytes=${pcm.length} ms=${Math.round(
                result.inferenceMs,
            )} chars=${text.length}`,
        );
        return {
            text,
            durationMs: Math.round((pcm.length / 2 / sampleRate) * 1000),
            inferenceMs: Math.round(result.inferenceMs),
        };
    }

    close(): void {
        this.options.host.closeAll();
    }
}

function decodeAudio(value: unknown): Buffer {
    if (typeof value !== 'string' || value.length === 0) {
        throw new VoiceTranscribeError(400, 'bad_request', 'audioBase64 不能为空');
    }
    // 先按长度粗判，避免为超大输入分配内存。
    if (value.length > Math.ceil((VOICE_MAX_AUDIO_BYTES * 4) / 3) + 16) {
        throw new VoiceTranscribeError(413, 'too_large', '音频过大（最多约 5 分钟）');
    }
    let buffer: Buffer;
    try {
        buffer = Buffer.from(value, 'base64');
    } catch {
        throw new VoiceTranscribeError(400, 'bad_request', 'audioBase64 非法');
    }
    if (buffer.length > VOICE_MAX_AUDIO_BYTES) {
        throw new VoiceTranscribeError(413, 'too_large', '音频过大（最多约 5 分钟）');
    }
    return buffer;
}

function normalizeLanguage(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length === 0) return 'auto';
    const normalized = value.trim().slice(0, 16);
    // SenseVoice 支持 auto/zh/en/yue/ja/ko；前端传 zh-CN 时收敛到 zh。
    if (normalized.toLowerCase().startsWith('zh')) return 'zh';
    if (normalized.toLowerCase().startsWith('en')) return 'en';
    return normalized;
}
