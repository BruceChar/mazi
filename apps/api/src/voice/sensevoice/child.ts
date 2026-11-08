import { createRequire } from 'node:module';
import type { VoiceErrorCode } from '@mazi/libs';
import {
    pcm16leToFloat32,
    probeSherpaNode,
    SherpaLoadError,
    sherpaChildEnv,
    toPcmBytes,
} from '../sherpa-engine.js';
import {
    SENSEVOICE_MODEL_PATH_ENV,
    SENSEVOICE_TOKENS_PATH_ENV,
    SENSEVOICE_VAD_PATH_ENV,
} from './assets.js';

/** host → child 请求。 */
export interface SenseVoiceChildTranscribeRequest {
    type: 'transcribe';
    id: number;
    /** advanced 序列化为 Uint8Array；兼容 JSON 序列化的 {type:'Buffer',data}。 */
    pcm: unknown;
    sampleRate: number;
    language: string;
}

export type SenseVoiceChildRequest = SenseVoiceChildTranscribeRequest | { type: 'shutdown' };

/** child → host 响应。 */
export type SenseVoiceChildResponse =
    | { type: 'ready' }
    | { type: 'result'; id: number; text: string; inferenceMs: number }
    | {
          type: 'error';
          id?: number;
          code?: VoiceErrorCode;
          message: string;
          retryable?: boolean;
      };

/** sherpa-onnx-node 的最小类型（包内无 .d.ts，只声明用到的部分）。 */
interface OfflineRecognizerStream {
    acceptWaveform(waveform: { samples: Float32Array; sampleRate: number }): void;
}

interface OfflineRecognizer {
    createStream(): OfflineRecognizerStream;
    decode(stream: OfflineRecognizerStream): void;
    getResult(stream: OfflineRecognizerStream): { text?: string };
}

interface SpeechSegment {
    start: number;
    samples: Float32Array;
}

interface Vad {
    acceptWaveform(samples: Float32Array): void;
    isEmpty(): boolean;
    front(): SpeechSegment;
    pop(): void;
    flush(): void;
    reset(): void;
}

interface OfflineRecognizerConfig {
    featConfig: { sampleRate: number; featureDim: number };
    modelConfig: {
        senseVoice: {
            model: string;
            language: string;
            useInverseTextNormalization: number;
        };
        tokens: string;
        numThreads: number;
        provider: string;
    };
    decodingMethod: 'greedy_search';
}

interface VadConfig {
    sileroVad: {
        model: string;
        threshold: number;
        minSilenceDuration: number;
        minSpeechDuration: number;
        maxSpeechDuration: number;
        windowSize: number;
    };
    sampleRate: number;
    numThreads: number;
    provider: string;
    debug: number;
}

interface SenseVoiceLibrary {
    OfflineRecognizer: new (config: OfflineRecognizerConfig) => OfflineRecognizer;
    Vad: new (config: VadConfig, bufferSizeSeconds: number) => Vad;
}

interface Engine {
    recognizer: OfflineRecognizer;
    vad: Vad;
}

const SAMPLE_RATE = 16000;
/** Silero VAD 16kHz 固定窗口。 */
const VAD_WINDOW_SIZE = 512;
/** VAD 内部环形缓冲秒数（覆盖 maxSpeechDuration=30s）。 */
const VAD_BUFFER_SECONDS = 32;

let engine: Engine | null = null;

/**
 * 整段离线转写 child 进程：SenseVoiceSmall + Silero VAD。
 *
 * 由 sensevoice-host.ts 通过 child_process.fork 启动；本文件被 tsc 编译为同目录
 * child.js。只有存在 process.send 时（即作为 fork 子进程运行）才启动消息循环，
 * 便于测试直接 import 类型而不产生副作用。
 *
 * 隐私：不记录任何音频字节或识别文本。
 */
function loadLibrary(): SenseVoiceLibrary {
    const probe = probeSherpaNode();
    if (!probe.available) {
        throw new SherpaLoadError(
            'engine_unavailable',
            '未找到 sherpa-onnx-node 依赖（可用 MAZI_VOICE_SHERPA_NODE_PATH 指定本地包）',
        );
    }
    // 本地验证时动态库搜索路径可能需要在 require 前写入进程环境。
    const prepared = sherpaChildEnv(process.env, probe);
    for (const [key, value] of Object.entries(prepared)) {
        if (typeof value === 'string' && key.endsWith('_LIBRARY_PATH')) process.env[key] = value;
    }
    const require = createRequire(import.meta.url);
    let loaded: Partial<SenseVoiceLibrary> | undefined;
    try {
        loaded = require(probe.specifier) as Partial<SenseVoiceLibrary> | undefined;
    } catch (error) {
        throw new SherpaLoadError(
            'engine_unavailable',
            `加载 sherpa-onnx-node 失败：${describeError(error)}`,
            true,
        );
    }
    if (
        !loaded ||
        typeof loaded.OfflineRecognizer !== 'function' ||
        typeof loaded.Vad !== 'function'
    ) {
        throw new SherpaLoadError(
            'engine_unavailable',
            'sherpa-onnx-node 未导出 OfflineRecognizer/Vad',
            true,
        );
    }
    return loaded as SenseVoiceLibrary;
}

function modelPathsFromEnv(): { model: string; tokens: string; vad: string } {
    const model = process.env[SENSEVOICE_MODEL_PATH_ENV]?.trim();
    const tokens = process.env[SENSEVOICE_TOKENS_PATH_ENV]?.trim();
    const vad = process.env[SENSEVOICE_VAD_PATH_ENV]?.trim();
    if (!model || !tokens || !vad) {
        throw new SherpaLoadError('model_missing', '未配置 SenseVoice 模型路径');
    }
    return { model, tokens, vad };
}

function createEngine(): Engine {
    const paths = modelPathsFromEnv();
    const sherpa = loadLibrary();
    const recognizer = new sherpa.OfflineRecognizer({
        featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
        modelConfig: {
            senseVoice: {
                model: paths.model,
                language: 'auto',
                useInverseTextNormalization: 1,
            },
            tokens: paths.tokens,
            numThreads: 2,
            provider: 'cpu',
        },
        decodingMethod: 'greedy_search',
    });
    const vad = new sherpa.Vad(
        {
            sileroVad: {
                model: paths.vad,
                threshold: 0.5,
                minSilenceDuration: 0.5,
                minSpeechDuration: 0.25,
                maxSpeechDuration: 30,
                windowSize: VAD_WINDOW_SIZE,
            },
            sampleRate: SAMPLE_RATE,
            numThreads: 1,
            provider: 'cpu',
            debug: 0,
        },
        VAD_BUFFER_SECONDS,
    );
    return { recognizer, vad };
}

function collectSegments(vad: Vad): Float32Array[] {
    const segments: Float32Array[] = [];
    while (!vad.isEmpty()) {
        const segment = vad.front();
        vad.pop();
        if (segment?.samples && segment.samples.length > 0) segments.push(segment.samples);
    }
    return segments;
}

function decodeSamples(recognizer: OfflineRecognizer, samples: Float32Array): string {
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
    recognizer.decode(stream);
    const result = recognizer.getResult(stream);
    return typeof result?.text === 'string' ? result.text.trim() : '';
}

function transcribePcm(
    current: Engine,
    pcm: Uint8Array,
    sampleRate: number,
): { text: string; inferenceMs: number } {
    const startedAt = Date.now();
    if (sampleRate !== SAMPLE_RATE) {
        throw new SherpaLoadError('bad_request', '仅支持 16kHz 单声道 PCM16');
    }
    const samples = pcm16leToFloat32(pcm);
    if (samples.length === 0) {
        return { text: '', inferenceMs: Date.now() - startedAt };
    }
    current.vad.reset();
    const segments: Float32Array[] = [];
    for (let offset = 0; offset < samples.length; offset += VAD_WINDOW_SIZE) {
        const end = Math.min(offset + VAD_WINDOW_SIZE, samples.length);
        const chunk =
            end - offset === VAD_WINDOW_SIZE
                ? samples.subarray(offset, end)
                : padWindow(samples.subarray(offset, end));
        current.vad.acceptWaveform(chunk);
        for (const segment of collectSegments(current.vad)) segments.push(segment);
    }
    current.vad.flush();
    for (const segment of collectSegments(current.vad)) segments.push(segment);
    if (segments.length === 0) {
        // VAD 没切出语音（静音/过短）时整段兜底，保证仍有一次识别结果。
        return {
            text: decodeSamples(current.recognizer, samples),
            inferenceMs: Date.now() - startedAt,
        };
    }
    const texts = segments
        .map((segment) => decodeSamples(current.recognizer, segment))
        .filter((text) => text.length > 0);
    return {
        text: texts.join(' '),
        inferenceMs: Date.now() - startedAt,
    };
}

function padWindow(partial: Float32Array): Float32Array {
    const padded = new Float32Array(VAD_WINDOW_SIZE);
    padded.set(partial);
    return padded;
}

function send(message: SenseVoiceChildResponse): void {
    if (typeof process.send === 'function' && process.connected) {
        process.send(message);
    }
}

function errorResponse(error: unknown, id?: number): SenseVoiceChildResponse {
    const code = error instanceof SherpaLoadError ? error.code : 'asr_failed';
    const retryable = error instanceof SherpaLoadError ? error.retryable : false;
    const message = error instanceof Error ? error.message : String(error);
    return {
        type: 'error',
        ...(id !== undefined ? { id } : {}),
        code,
        message,
        retryable,
    };
}

function handleTranscribe(request: SenseVoiceChildTranscribeRequest): void {
    if (!engine) {
        send({
            type: 'error',
            id: request.id,
            code: 'engine_unavailable',
            message: '语音转写引擎尚未就绪',
            retryable: true,
        });
        return;
    }
    try {
        const pcm = toPcmBytes(request.pcm);
        const result = transcribePcm(engine, pcm, Number(request.sampleRate) || SAMPLE_RATE);
        send({
            type: 'result',
            id: request.id,
            text: result.text,
            inferenceMs: result.inferenceMs,
        });
    } catch (error) {
        send(errorResponse(error, request.id));
    }
}

async function handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') return;
    const request = message as SenseVoiceChildRequest;
    switch (request.type) {
        case 'transcribe':
            handleTranscribe(request);
            break;
        case 'shutdown':
            engine = null;
            process.exit(0);
            break;
        default:
            break;
    }
}

function reportStartupError(error: unknown): void {
    if (typeof process.send === 'function' && process.connected) {
        process.send(errorResponse(error), () => process.exit(1));
        // IPC 不可用时兜底退出，避免半初始化进程一直占着。
        const timer = setTimeout(() => process.exit(1), 1000);
        timer.unref?.();
        return;
    }
    process.exitCode = 1;
}

function main(): void {
    process.on('message', (message: unknown) => {
        void handleMessage(message).catch((error: unknown) => {
            send(errorResponse(error));
        });
    });
    process.on('disconnect', () => {
        engine = null;
        process.exit(0);
    });
    process.on('uncaughtException', (error: Error) => {
        send(errorResponse(error));
        process.exit(1);
    });
    process.on('unhandledRejection', (reason: unknown) => {
        send(errorResponse(reason));
    });
    try {
        engine = createEngine();
        send({ type: 'ready' });
    } catch (error) {
        reportStartupError(error);
    }
}

function describeError(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

if (typeof process.send === 'function') {
    main();
}
