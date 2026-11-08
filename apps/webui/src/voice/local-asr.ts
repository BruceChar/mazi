/**
 * 本机语音 HTTP 客户端。
 *
 * 主路径（DSH 方式）：整段录音离线转写
 *   `transcribePcm` / `transcribeAudio` → POST /api/voice/asr/transcribe
 *   一次上传完整 PCM16，停止录音后调用，一次性返回整段文字（无 partial）。
 *
 * 兼容保留：`LocalAsrClient`（旧的流式 chunk 协议 POST /api/voice/asr/chunk）
 * 已不再被控制器使用，仅保留导出以免破坏历史引用。
 *
 * 统一约定：超时 / cancel 支持；错误映射为 VoiceErrorInfo；API_BASE 与
 * `?api=` 兼容沿用 ../api.ts。
 */
import type {
    CreateVoiceSessionResponse,
    VoiceCapabilities,
    VoiceChunkResponse,
    VoiceErrorCode,
    VoiceLimits,
    VoiceModelInfo,
    VoiceTranscribeRequest,
    VoiceTranscribeResponse,
} from '@mazi/libs';
import { API_BASE } from '../api.ts';
import type { VoiceErrorInfo } from './types.ts';

export const VOICE_HTTP_TIMEOUT_MS = 12_000;
export const VOICE_FINAL_TIMEOUT_MS = 8_000;
/** 整段离线转写：最长 5 分钟音频，本机推理 + 上传给足 120s。 */
export const VOICE_TRANSCRIBE_TIMEOUT_MS = 120_000;

/** HTTP 层错误：保留服务端 { error, code, retryable } 契约。 */
export class VoiceHttpError extends Error {
    readonly code: VoiceErrorCode | string;
    readonly retryable: boolean;
    readonly status: number;

    constructor(
        message: string,
        options: { code?: string; retryable?: boolean; status?: number } = {},
    ) {
        super(message);
        this.name = 'VoiceHttpError';
        this.code = options.code ?? 'internal_error';
        this.retryable = options.retryable ?? false;
        this.status = options.status ?? 0;
    }
}

export function toVoiceErrorInfo(error: unknown): VoiceErrorInfo {
    if (error instanceof VoiceHttpError) {
        return { code: error.code, message: error.message, retryable: error.retryable };
    }
    if (error instanceof Error) {
        return { code: 'internal_error', message: error.message, retryable: true };
    }
    return { code: 'internal_error', message: String(error), retryable: true };
}

interface RequestOptions {
    method?: 'GET' | 'POST' | 'DELETE';
    body?: unknown;
    timeoutMs?: number;
    signal?: AbortSignal;
}

/** 统一请求：超时、JSON 解析、错误契约映射。 */
async function requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const timeoutMs = options.timeoutMs ?? VOICE_HTTP_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
        const res = await fetch(API_BASE + path, {
            method: options.method ?? 'GET',
            headers: options.body == null ? undefined : { 'content-type': 'application/json' },
            body: options.body == null ? undefined : JSON.stringify(options.body),
            signal: controller.signal,
            cache: 'no-store',
        });
        let data: Record<string, unknown> = {};
        try {
            data = (await res.json()) as Record<string, unknown>;
        } catch {
            data = {};
        }
        if (!res.ok) {
            throw new VoiceHttpError(
                typeof data.error === 'string' ? data.error : `${res.status} ${res.statusText}`,
                {
                    code: typeof data.code === 'string' ? data.code : undefined,
                    retryable: typeof data.retryable === 'boolean' ? data.retryable : false,
                    status: res.status,
                },
            );
        }
        return data as T;
    } catch (error) {
        if (error instanceof VoiceHttpError) throw error;
        if (error instanceof DOMException && error.name === 'AbortError') {
            throw new VoiceHttpError('语音请求超时', { code: 'timeout', retryable: true });
        }
        throw new VoiceHttpError(error instanceof Error ? error.message : String(error), {
            code: 'internal_error',
            retryable: true,
        });
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
    }
}

/* ---------------------------- REST endpoints ---------------------------- */

export async function fetchVoiceCapabilities(): Promise<VoiceCapabilities> {
    return requestJson<VoiceCapabilities>('/api/voice/capabilities');
}

export async function fetchVoiceModels(): Promise<VoiceModelInfo[]> {
    const data = await requestJson<{ models?: VoiceModelInfo[] } | VoiceModelInfo[]>(
        '/api/voice/models',
    );
    return Array.isArray(data) ? data : (data.models ?? []);
}

export async function startVoiceModelDownload(id: string): Promise<{ jobId: string }> {
    return requestJson<{ jobId: string }>(`/api/voice/models/${encodeURIComponent(id)}/download`, {
        method: 'POST',
        body: {},
        timeoutMs: 30_000,
    });
}

export interface VoiceModelDownloadStatus {
    status: 'running' | 'done' | 'error' | 'queued';
    progress: number;
    error?: string;
}

export async function fetchVoiceModelDownload(jobId: string): Promise<VoiceModelDownloadStatus> {
    return requestJson<VoiceModelDownloadStatus>(
        `/api/voice/models/downloads/${encodeURIComponent(jobId)}`,
        { timeoutMs: 15_000 },
    );
}

export async function deleteVoiceModel(id: string): Promise<void> {
    await requestJson<unknown>(`/api/voice/models/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        timeoutMs: 15_000,
    });
}

/* ---------------------------- transcribe ------------------------------- */

export interface VoiceTranscribeOptions {
    sampleRate?: number;
    language?: string;
    timeoutMs?: number;
    /** 取消进行中的转写（打字 / 切换会话 / destroy）。 */
    signal?: AbortSignal;
}

/**
 * 整段录音离线转写（DSH 方式）：POST /api/voice/asr/transcribe。
 *
 * 一次请求上传完整 PCM16LE / mono / 16kHz（base64，无 WAV 头），
 * 停止录音后调用，返回整段文字；不是流式 partial。
 */
export async function transcribeAudio(
    request: VoiceTranscribeRequest,
    options: VoiceTranscribeOptions = {},
): Promise<VoiceTranscribeResponse> {
    return requestJson<VoiceTranscribeResponse>('/api/voice/asr/transcribe', {
        method: 'POST',
        body: request,
        timeoutMs: options.timeoutMs ?? VOICE_TRANSCRIBE_TIMEOUT_MS,
        ...(options.signal ? { signal: options.signal } : {}),
    });
}

/** Int16 PCM → base64 → 转写。控制器停止录音后调用一次。 */
export async function transcribePcm(
    pcm: Int16Array,
    options: VoiceTranscribeOptions = {},
): Promise<VoiceTranscribeResponse> {
    if (!pcm || pcm.length === 0) {
        throw new VoiceHttpError('没有录到声音', { code: 'bad_request', retryable: true });
    }
    return transcribeAudio(
        {
            audioBase64: pcmToBase64(pcm),
            sampleRate: options.sampleRate ?? 16_000,
            ...(options.language ? { language: options.language } : {}),
        },
        options,
    );
}

/* ------------------------------ session -------------------------------- */

export interface LocalAsrClientOptions {
    language?: string;
    modelId?: string;
    onPartial?: (text: string, revision: number) => void;
    onFinal?: (text: string) => void;
    onError?: (error: VoiceErrorInfo) => void;
    /** 队列上限（帧数）；超出时丢弃最旧帧并提示（默认 80 帧 ≈ 8s）。 */
    maxBacklogFrames?: number;
    /** final 等待上限。 */
    finalTimeoutMs?: number;
}

interface QueuedChunk {
    pcm: Uint8Array;
    end: boolean;
}

/**
 * Uint8Array → base64。
 *
 * 分块处理（每块 32KB）：5 分钟 PCM16 ≈ 9.6MB，一次性 `String.fromCharCode(...)`
 * 会因参数过多爆栈；分段拼接是安全的。
 */
export function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
        binary += String.fromCharCode(...bytes.subarray(i, i + step));
    }
    return btoa(binary);
}

/** PCM16（Int16Array）→ base64（按字节视图编码，不复制样本）。 */
export function pcmToBase64(pcm: Int16Array): string {
    return bytesToBase64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
}

function toBytes(pcm: Int16Array | Uint8Array): Uint8Array {
    if (pcm instanceof Uint8Array) return pcm;
    return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

/**
 * 一次 utterance 的本机识别客户端：创建 session → 顺序上传 chunk → final。
 * 调用方（Controller）负责 VAD 端点判定与文本注入。
 */
export class LocalAsrClient {
    private readonly options: LocalAsrClientOptions;
    private session: CreateVoiceSessionResponse | null = null;
    private seq = 0;
    private queue: QueuedChunk[] = [];
    private sending = false;
    private closed = false;
    private lastRevision = -1;
    private inflight: AbortController | null = null;
    private finalResolve: (() => void) | null = null;
    private finalTimer: ReturnType<typeof setTimeout> | null = null;
    private ended = false;

    constructor(options: LocalAsrClientOptions = {}) {
        this.options = options;
    }

    get sessionId(): string | null {
        return this.session?.sessionId ?? null;
    }

    get limits(): VoiceLimits | null {
        return this.session?.limits ?? null;
    }

    get seqValue(): number {
        return this.seq;
    }

    get isClosed(): boolean {
        return this.closed;
    }

    /** 创建一次性 session（POST /api/voice/asr/sessions）。 */
    async start(): Promise<VoiceLimits> {
        const body: Record<string, string> = {};
        if (this.options.modelId) body.modelId = this.options.modelId;
        if (this.options.language) body.language = this.options.language;
        try {
            const session = await requestJson<CreateVoiceSessionResponse>(
                '/api/voice/asr/sessions',
                { method: 'POST', body, timeoutMs: 20_000 },
            );
            if (!session?.sessionId || !session?.token) {
                throw new VoiceHttpError('语音会话创建失败（响应缺少 sessionId/token）', {
                    code: 'internal_error',
                    retryable: true,
                });
            }
            this.session = session;
            return session.limits;
        } catch (error) {
            this.closed = true;
            this.options.onError?.(toVoiceErrorInfo(error));
            throw error;
        }
    }

    /** 入队一帧 PCM16LE / mono / 16kHz；顺序发送，超出背压上限丢最旧帧。 */
    pushPcm(pcm: Int16Array | Uint8Array): void {
        if (this.closed || this.ended || !this.session) return;
        this.enqueue({ pcm: toBytes(pcm), end: false });
    }

    /**
     * 结束当前 utterance：追加一个 end=true 的空帧（服务端据此释放 session）。
     * 返回 final/error 落定后 resolve 的 Promise。
     */
    end(): Promise<void> {
        if (this.ended) return Promise.resolve();
        this.ended = true;
        if (this.closed || !this.session) return Promise.resolve();
        this.enqueue({ pcm: new Uint8Array(0), end: true });
        return new Promise<void>((resolve) => {
            this.finalResolve = resolve;
            const timeout = this.options.finalTimeoutMs ?? VOICE_FINAL_TIMEOUT_MS;
            this.finalTimer = setTimeout(() => {
                if (this.closed) return;
                this.closed = true;
                this.options.onError?.({
                    code: 'timeout',
                    message: '本机识别超时，请再说一次。',
                    retryable: true,
                });
                this.settle();
            }, timeout);
        });
    }

    /** 取消：丢弃队列并中止在途请求；不再触发回调。 */
    cancel(): void {
        if (this.closed) return;
        const session = this.session;
        const seq = this.seq;
        const ended = this.ended;
        this.closed = true;
        this.queue = [];
        this.inflight?.abort();
        this.inflight = null;
        this.settle();
        // 释放服务端 session，避免下一次录音报“语音识别繁忙”。
        if (session && !ended) {
            void fetch(API_BASE + '/api/voice/asr/chunk', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    sessionId: session.sessionId,
                    token: session.token,
                    seq: seq + 1,
                    pcmBase64: '',
                    end: true,
                }),
                cache: 'no-store',
            }).catch(() => undefined);
        }
    }

    private enqueue(chunk: QueuedChunk): void {
        const maxBacklog = this.options.maxBacklogFrames ?? 80;
        this.queue.push(chunk);
        if (this.queue.length > maxBacklog) {
            this.queue.splice(0, this.queue.length - maxBacklog);
            this.options.onError?.({
                code: 'busy',
                message: '本机识别处理不过来，已丢弃最旧的音频。',
                retryable: true,
            });
        }
        void this.pump();
    }

    private async pump(): Promise<void> {
        if (this.sending || this.closed) return;
        this.sending = true;
        while (this.queue.length > 0 && !this.closed) {
            const chunk = this.queue.shift();
            if (!chunk) break;
            await this.sendChunk(chunk);
        }
        this.sending = false;
    }

    private async sendChunk(chunk: QueuedChunk): Promise<void> {
        const session = this.session;
        if (!session || this.closed) return;
        const controller = new AbortController();
        this.inflight = controller;
        try {
            const response = await requestJson<VoiceChunkResponse>('/api/voice/asr/chunk', {
                method: 'POST',
                body: {
                    sessionId: session.sessionId,
                    token: session.token,
                    seq: this.seq,
                    pcmBase64: bytesToBase64(chunk.pcm),
                    ...(chunk.end ? { end: true } : {}),
                },
                signal: controller.signal,
            });
            this.seq += 1;
            if (!this.closed) this.handleResponse(response);
        } catch (error) {
            if (this.closed) return;
            this.closed = true;
            this.options.onError?.(toVoiceErrorInfo(error));
            this.settle();
        } finally {
            if (this.inflight === controller) this.inflight = null;
        }
    }

    private handleResponse(response: VoiceChunkResponse): void {
        if (!response || typeof response !== 'object') return;
        if (response.type === 'partial') {
            const revision =
                typeof response.revision === 'number' ? response.revision : this.lastRevision + 1;
            if (revision <= this.lastRevision) return;
            this.lastRevision = revision;
            if (typeof response.text === 'string')
                this.options.onPartial?.(response.text, revision);
            return;
        }
        if (response.type === 'final') {
            this.closed = true;
            this.options.onFinal?.(typeof response.text === 'string' ? response.text : '');
            this.settle();
            return;
        }
        if (response.type === 'error') {
            this.closed = true;
            this.options.onError?.({
                code: response.error?.code ?? 'asr_failed',
                message: response.error?.message ?? '本机识别失败',
                retryable: response.error?.retryable ?? true,
            });
            this.settle();
        }
    }

    private settle(): void {
        if (this.finalTimer) {
            clearTimeout(this.finalTimer);
            this.finalTimer = null;
        }
        const resolve = this.finalResolve;
        this.finalResolve = null;
        resolve?.();
    }
}
