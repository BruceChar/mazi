/**
 * 语音输入共享契约（WebUI ↔ API）。
 *
 * 设计：docs/web/语音输入设计.md。当前 P0 传输采用本机 HTTP 分块上传
 * （POST /api/voice/asr/chunk），而不是 WebSocket，以避免额外 native/WS 依赖；
 * 协议字段保持与设计文档的 partial/final/error 语义一致。
 */

/** 对外协议版本；服务端 capabilities 返回。 */
export const VOICE_PROTOCOL_VERSION = 1;

export type VoiceEngineId = 'local' | 'browser-on-device' | 'browser-cloud' | 'none';

export type VoiceErrorCode =
    | 'bad_request'
    | 'unauthorized'
    | 'forbidden'
    | 'not_found'
    | 'model_missing'
    | 'engine_unavailable'
    | 'busy'
    | 'rate_limited'
    | 'too_large'
    | 'timeout'
    | 'session_expired'
    | 'asr_failed'
    | 'internal_error';

export interface VoiceApiError {
    code: VoiceErrorCode;
    message: string;
    retryable: boolean;
}

export interface VoiceLimits {
    /** 单次 chunk 解码后的 PCM 上限（字节）。 */
    maxChunkBytes: number;
    /** 单条 utterance 上限（毫秒）。 */
    maxUtteranceMs: number;
    /** 单个识别 session 上限（毫秒）。 */
    maxSessionMs: number;
    /** 并发识别 session 上限。 */
    maxSessions: number;
    /** final 文本过短时客户端应丢弃。 */
    minFinalChars: number;
}

export interface VoiceModelInfo {
    id: string;
    name: string;
    description: string;
    languages: string[];
    sizeBytes: number;
    license: string;
    licenseUrl?: string;
    installed: boolean;
    /** 默认模型标记。 */
    recommended?: boolean;
}

export interface VoiceCapabilities {
    version: number;
    engines: {
        local: {
            available: boolean;
            reason?: string;
            modelId?: string;
        };
    };
    models: VoiceModelInfo[];
    limits: VoiceLimits;
    security: {
        loopbackOnly: boolean;
        secureContextRequired: boolean;
    };
}

export interface CreateVoiceSessionRequest {
    modelId?: string;
    language?: string;
}

export interface CreateVoiceSessionResponse {
    sessionId: string;
    token: string;
    expiresAt: number;
    limits: VoiceLimits;
}

export interface VoiceChunkRequest {
    sessionId: string;
    token: string;
    /** 单调递增序号（从 0 开始），服务端用于丢弃重复/乱序 chunk。 */
    seq: number;
    /** PCM16LE / mono / 16kHz 的 base64。 */
    pcmBase64: string;
    /** true 表示这是本次 utterance 的最后一帧。 */
    end?: boolean;
}

export interface VoiceChunkResponse {
    type: 'partial' | 'final' | 'error';
    /** partial 的累计假设版本；单调递增。 */
    revision?: number;
    /** partial / final 文本（累计假设，不是 delta）。 */
    text?: string;
    latencyMs?: number;
    /** final 已落定，服务端已释放 session。 */
    done?: boolean;
    error?: VoiceApiError;
}

export const VOICE_DEFAULT_LIMITS: VoiceLimits = {
    maxChunkBytes: 64 * 1024,
    maxUtteranceMs: 30_000,
    maxSessionMs: 5 * 60_000,
    maxSessions: 1,
    minFinalChars: 2,
};

export const VOICE_DEFAULT_LANGUAGE = 'zh-CN';

/** 服务端默认模型（与 API 模型注册表保持一致）。 */
export const VOICE_DEFAULT_MODEL_ID = 'sherpa-streaming-small-bilingual-zh-en';
