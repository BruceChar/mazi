import type { VoiceErrorCode } from '@mazi/libs';
import {
    buildOnlineRecognizerConfig,
    discoverModelFiles,
    loadSherpaModule,
    pcm16leToFloat32,
    SherpaLoadError,
    type SherpaNodeModule,
    type SherpaOnlineRecognizer,
    type SherpaOnlineStream,
    toPcmBytes,
} from './sherpa-engine.js';

/** 子进程请求（host → child，均带 id 以便请求-响应关联）。 */
export interface ChildOpenRequest {
    type: 'open';
    id: number;
    sessionId: string;
    modelId: string;
    modelDir: string;
    language: string;
    sampleRate: number;
}

export interface ChildAudioRequest {
    type: 'audio';
    id: number;
    sessionId: string;
    /** advanced 序列化为 Uint8Array；兼容 JSON 序列化的 {type:'Buffer',data}。 */
    pcm: unknown;
}

export interface ChildEndRequest {
    type: 'end';
    id: number;
    sessionId: string;
}

export interface ChildCloseRequest {
    type: 'close';
    sessionId: string;
}

export interface ChildShutdownRequest {
    type: 'shutdown';
}

export type ChildRequest =
    | ChildOpenRequest
    | ChildAudioRequest
    | ChildEndRequest
    | ChildCloseRequest
    | ChildShutdownRequest;

/** 子进程响应（child → host）。 */
export type ChildResponse =
    | { type: 'opened'; id: number; sessionId: string }
    | { type: 'partial'; id: number; sessionId: string; text: string }
    | { type: 'final'; id: number; sessionId: string; text: string; durationMs: number }
    | {
          type: 'error';
          id?: number;
          sessionId?: string;
          code: VoiceErrorCode;
          message: string;
          retryable?: boolean;
      };

interface ChildSession {
    sessionId: string;
    recognizer: SherpaOnlineRecognizer;
    stream: SherpaOnlineStream;
    latestText: string;
    createdAt: number;
}

const sessions = new Map<string, ChildSession>();
const recognizers = new Map<string, SherpaOnlineRecognizer>();
let sherpaModule: SherpaNodeModule | null = null;

/**
 * 语音识别 child 进程：动态加载 sherpa-onnx-node，按 session 串行解码。
 *
 * 由 sherpa-host.ts 通过 child_process.fork 启动；本文件被 tsc 编译为同目录
 * sherpa-child.js。只有存在 process.send 时（即作为 fork 子进程运行）才启动
 * 消息循环，便于测试直接 import 本模块的类型/纯函数而不产生副作用。
 */
async function getRecognizer(modelDir: string): Promise<SherpaOnlineRecognizer> {
    const cached = recognizers.get(modelDir);
    if (cached) return cached;
    const files = await discoverModelFiles(modelDir);
    sherpaModule ??= loadSherpaModule();
    const config = buildOnlineRecognizerConfig(modelDir, files);
    const recognizer = new sherpaModule.OnlineRecognizer(config);
    recognizers.set(modelDir, recognizer);
    return recognizer;
}

async function handleOpen(request: ChildOpenRequest): Promise<void> {
    const recognizer = await getRecognizer(request.modelDir);
    const stream = recognizer.createStream();
    sessions.set(request.sessionId, {
        sessionId: request.sessionId,
        recognizer,
        stream,
        latestText: '',
        createdAt: Date.now(),
    });
    send({ type: 'opened', id: request.id, sessionId: request.sessionId });
}

function handleAudio(request: ChildAudioRequest): void {
    const session = sessions.get(request.sessionId);
    if (!session) {
        send({
            type: 'error',
            id: request.id,
            sessionId: request.sessionId,
            code: 'asr_failed',
            message: '语音识别会话不存在或已结束',
        });
        return;
    }
    const pcm = toPcmBytes(request.pcm);
    if (pcm.byteLength === 0) {
        send({ type: 'partial', id: request.id, sessionId: request.sessionId, text: '' });
        return;
    }
    const samples = pcm16leToFloat32(pcm);
    session.stream.acceptWaveform({ samples, sampleRate: 16000 });
    while (session.recognizer.isReady(session.stream)) {
        session.recognizer.decode(session.stream);
    }
    const result = session.recognizer.getResult(session.stream);
    const text = typeof result.text === 'string' ? result.text : '';
    const changed = text !== session.latestText;
    session.latestText = text;
    // 文本未变化时只回空 partial 作为 ack，避免 UI revision 抖动。
    send({
        type: 'partial',
        id: request.id,
        sessionId: request.sessionId,
        text: changed ? text : '',
    });
}

function handleEnd(request: ChildEndRequest): void {
    const session = sessions.get(request.sessionId);
    if (!session) {
        send({
            type: 'error',
            id: request.id,
            sessionId: request.sessionId,
            code: 'asr_failed',
            message: '语音识别会话不存在或已结束',
        });
        return;
    }
    try {
        session.stream.inputFinished();
        while (session.recognizer.isReady(session.stream)) {
            session.recognizer.decode(session.stream);
        }
        const result = session.recognizer.getResult(session.stream);
        const text = typeof result.text === 'string' ? result.text : session.latestText;
        sessions.delete(request.sessionId);
        send({
            type: 'final',
            id: request.id,
            sessionId: request.sessionId,
            text,
            durationMs: Math.max(0, Date.now() - session.createdAt),
        });
    } catch (error) {
        sessions.delete(request.sessionId);
        throw error;
    }
}

function handleClose(request: ChildCloseRequest): void {
    sessions.delete(request.sessionId);
}

function handleShutdown(): void {
    sessions.clear();
    recognizers.clear();
    sherpaModule = null;
    process.exit(0);
}

async function handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') return;
    const request = message as ChildRequest;
    switch (request.type) {
        case 'open':
            await handleOpen(request);
            break;
        case 'audio':
            handleAudio(request);
            break;
        case 'end':
            handleEnd(request);
            break;
        case 'close':
            handleClose(request);
            break;
        case 'shutdown':
            handleShutdown();
            break;
        default:
            break;
    }
}

function send(message: ChildResponse): void {
    if (typeof process.send === 'function' && process.connected) {
        process.send(message);
    }
}

function reportError(error: unknown, fallback?: { id?: number; sessionId?: string }): void {
    const code = error instanceof SherpaLoadError ? error.code : 'asr_failed';
    const retryable = error instanceof SherpaLoadError ? error.retryable : false;
    const text = error instanceof Error ? error.message : String(error);
    send({
        type: 'error',
        ...(fallback?.id !== undefined ? { id: fallback.id } : {}),
        ...(fallback?.sessionId ? { sessionId: fallback.sessionId } : {}),
        code,
        message: text,
        retryable,
    });
}

function main(): void {
    process.on('message', (message: unknown) => {
        const request = message as Partial<ChildSession> & { id?: number; sessionId?: string };
        void handleMessage(message).catch((error: unknown) => {
            reportError(error, {
                ...(typeof request.id === 'number' ? { id: request.id } : {}),
                ...(typeof request.sessionId === 'string' ? { sessionId: request.sessionId } : {}),
            });
        });
    });
    process.on('disconnect', () => {
        sessions.clear();
        process.exit(0);
    });
    process.on('uncaughtException', (error: Error) => {
        reportError(error);
        process.exit(1);
    });
    process.on('unhandledRejection', (reason: unknown) => {
        reportError(reason);
    });
}

if (typeof process.send === 'function') {
    main();
}
