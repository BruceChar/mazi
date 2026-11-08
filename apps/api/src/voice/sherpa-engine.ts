import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { arch, homedir, platform } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { VoiceErrorCode } from '@mazi/libs';

/** 本地 sherpa-onnx-node 包目录覆盖（本地验证/离线分发用）。 */
export const SHERPA_NODE_PATH_ENV = 'MAZI_VOICE_SHERPA_NODE_PATH';

/** sherpa-onnx-node 的模型文件（相对模型目录的文件名）。 */
export interface SherpaModelFiles {
    encoder: string;
    decoder: string;
    joiner: string;
    tokens: string;
}

/** 模型目录缺失/不完整错误（child 端映射为 voice API 错误码）。 */
export class SherpaLoadError extends Error {
    readonly code: VoiceErrorCode;
    readonly retryable: boolean;

    constructor(code: VoiceErrorCode, message: string, retryable = false) {
        super(message);
        this.name = 'SherpaLoadError';
        this.code = code;
        this.retryable = retryable;
    }
}

/** sherpa-onnx-node 的最小类型（包内无 .d.ts，这里只声明用到的部分）。 */
export interface SherpaOnlineStream {
    acceptWaveform(waveform: { samples: Float32Array; sampleRate: number }): void;
    inputFinished(): void;
}

export interface SherpaOnlineRecognizer {
    createStream(): SherpaOnlineStream;
    isReady(stream: SherpaOnlineStream): boolean;
    decode(stream: SherpaOnlineStream): void;
    getResult(stream: SherpaOnlineStream): { text?: string };
}

export interface SherpaNodeModule {
    OnlineRecognizer: new (config: OnlineRecognizerConfig) => SherpaOnlineRecognizer;
}

export interface OnlineRecognizerConfig {
    featConfig: { sampleRate: number; featureDim: number };
    modelConfig: {
        transducer: { encoder: string; decoder: string; joiner: string };
        tokens: string;
        numThreads: number;
        provider: string;
    };
    decodingMethod: 'greedy_search';
    enableEndpoint: boolean;
    rule1MinTrailingSilence: number;
    rule2MinTrailingSilence: number;
    rule3MinUtteranceLength: number;
}

export interface SherpaNodeProbe {
    available: boolean;
    /** 机器码，便于 capabilities 原样返回。 */
    reason?: 'engine_missing';
    /** child 端 require 使用的 specifier：包名或本地绝对目录。 */
    specifier: string;
    /** 本地覆盖目录（MAZI_VOICE_SHERPA_NODE_PATH 展开后）。 */
    localPath?: string;
    /** 包解析到的入口文件（本地覆盖时为 undefined）。 */
    resolvedPath?: string;
}

/**
 * 探测本机是否可加载 sherpa-onnx-node：
 * - MAZI_VOICE_SHERPA_NODE_PATH 指向本地包目录时要求目录存在；
 * - 否则用 createRequire 解析 'sherpa-onnx-node'（未声明依赖/未安装即不可用）。
 */
export function probeSherpaNode(env: NodeJS.ProcessEnv = process.env): SherpaNodeProbe {
    const override = env[SHERPA_NODE_PATH_ENV]?.trim();
    if (override) {
        const localPath = resolve(expandUserPath(override));
        if (!existsSync(localPath)) {
            return { available: false, reason: 'engine_missing', specifier: localPath, localPath };
        }
        return { available: true, specifier: localPath, localPath };
    }
    const require = createRequire(import.meta.url);
    try {
        const resolvedPath = require.resolve('sherpa-onnx-node');
        return { available: true, specifier: 'sherpa-onnx-node', resolvedPath };
    } catch {
        return { available: false, reason: 'engine_missing', specifier: 'sherpa-onnx-node' };
    }
}

/** 本地包目录下平台 native 包（libonnxruntime 等动态库所在目录）。 */
export function findNativeLibDir(packageDir: string): string | undefined {
    const platformName = platform() === 'win32' ? 'win' : platform();
    const packageName = `sherpa-onnx-${platformName}-${arch()}`;
    const candidates = [
        join(packageDir, 'node_modules', packageName),
        join(dirname(packageDir), packageName),
        join(resolve(packageDir, '..'), packageName),
    ];
    return candidates.find((candidate) => existsSync(candidate));
}

/**
 * 生成 child 进程环境：本地包目录时把平台 native 库目录加入动态库搜索路径，
 * 保证 macOS/Linux 下 addon 能找到 libonnxruntime / libsherpa-onnx。
 */
export function sherpaChildEnv(
    env: NodeJS.ProcessEnv = process.env,
    probe: SherpaNodeProbe = probeSherpaNode(env),
): NodeJS.ProcessEnv {
    const result: NodeJS.ProcessEnv = { ...env };
    const packageDir =
        probe.localPath ?? (probe.resolvedPath ? dirname(probe.resolvedPath) : undefined);
    if (!packageDir) return result;
    const libDir = findNativeLibDir(packageDir);
    if (!libDir) return result;
    const key =
        platform() === 'darwin'
            ? 'DYLD_LIBRARY_PATH'
            : platform() === 'win32'
              ? 'PATH'
              : 'LD_LIBRARY_PATH';
    const separator = platform() === 'win32' ? ';' : ':';
    const current = result[key];
    result[key] = current && current.length > 0 ? `${libDir}${separator}${current}` : libDir;
    return result;
}

/** child 端动态加载 sherpa-onnx-node；失败统一转 SherpaLoadError。 */
export function loadSherpaModule(env: NodeJS.ProcessEnv = process.env): SherpaNodeModule {
    const probe = probeSherpaNode(env);
    if (!probe.available) {
        throw new SherpaLoadError(
            'engine_unavailable',
            '未找到 sherpa-onnx-node 依赖（可用 MAZI_VOICE_SHERPA_NODE_PATH 指定本地包）',
        );
    }
    // 本地验证时动态库搜索路径可能需要在 require 前写入进程环境。
    const prepared = sherpaChildEnv(env, probe);
    for (const [key, value] of Object.entries(prepared)) {
        if (typeof value === 'string' && key.endsWith('_LIBRARY_PATH')) process.env[key] = value;
    }
    const require = createRequire(import.meta.url);
    try {
        const loaded = require(probe.specifier) as Partial<SherpaNodeModule> | undefined;
        if (!loaded || typeof loaded.OnlineRecognizer !== 'function') {
            throw new Error('模块未导出 OnlineRecognizer');
        }
        return loaded as SherpaNodeModule;
    } catch (error) {
        throw new SherpaLoadError(
            'engine_unavailable',
            `加载 sherpa-onnx-node 失败：${describeError(error)}`,
            true,
        );
    }
}

/**
 * 扫描模型目录，定位流式模型文件。
 * 约定：encoder / decoder / joiner 的 .onnx 文件 + tokens.txt；优先使用 int8 量化文件。
 */
export async function discoverModelFiles(modelDir: string): Promise<SherpaModelFiles> {
    const entries = await readdir(modelDir, { withFileTypes: true }).catch((error: unknown) => {
        throw new SherpaLoadError('model_missing', `模型目录不可读：${describeError(error)}`);
    });
    const names = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    const pick = (kind: 'encoder' | 'decoder' | 'joiner'): string => {
        const candidates = names.filter(
            (name) => name.toLowerCase().includes(kind) && name.toLowerCase().endsWith('.onnx'),
        );
        if (candidates.length === 0) {
            throw new SherpaLoadError('model_missing', `模型目录缺少 ${kind} 文件：${modelDir}`);
        }
        const int8 = candidates.filter((name) => name.toLowerCase().includes('int8'));
        return (int8.length > 0 ? int8 : candidates).sort()[0];
    };
    const tokens =
        names.find((name) => name === 'tokens.txt') ??
        names.find((name) => /^tokens.*\.txt$/i.test(name));
    if (!tokens) {
        throw new SherpaLoadError('model_missing', `模型目录缺少 tokens.txt：${modelDir}`);
    }
    return {
        encoder: pick('encoder'),
        decoder: pick('decoder'),
        joiner: pick('joiner'),
        tokens,
    };
}

/** 由模型文件构造 OnlineRecognizer 配置（纯函数，便于单测）。 */
export function buildOnlineRecognizerConfig(
    modelDir: string,
    files: SherpaModelFiles,
): OnlineRecognizerConfig {
    return {
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
            transducer: {
                encoder: join(modelDir, files.encoder),
                decoder: join(modelDir, files.decoder),
                joiner: join(modelDir, files.joiner),
            },
            tokens: join(modelDir, files.tokens),
            numThreads: 1,
            provider: 'cpu',
        },
        decodingMethod: 'greedy_search',
        enableEndpoint: true,
        // 端点判定仅作为辅助信息；最终是否结束由客户端 VAD 的 end 决定。
        rule1MinTrailingSilence: 2.4,
        rule2MinTrailingSilence: 1.2,
        rule3MinUtteranceLength: 30,
    };
}

/** PCM16LE / mono → Float32（[-1, 1)），奇数尾字节丢弃。 */
export function pcm16leToFloat32(pcm: Uint8Array): Float32Array {
    const length = Math.floor(pcm.byteLength / 2);
    const samples = new Float32Array(length);
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let i = 0; i < length; i += 1) {
        samples[i] = view.getInt16(i * 2, true) / 32768;
    }
    return samples;
}

/** 归一化 IPC 传来的 PCM（advanced 序列化为 Uint8Array；JSON 序列化为 {type:'Buffer',data}）。 */
export function toPcmBytes(payload: unknown): Uint8Array {
    if (payload instanceof Uint8Array) return payload;
    if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
    if (ArrayBuffer.isView(payload)) {
        return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
    }
    if (payload && typeof payload === 'object') {
        const candidate = payload as { type?: unknown; data?: unknown };
        if (candidate.type === 'Buffer' && Array.isArray(candidate.data)) {
            return Uint8Array.from(candidate.data as number[]);
        }
    }
    return new Uint8Array(0);
}

function describeError(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

function expandUserPath(value: string): string {
    if (value === '~') return homedir();
    if (value.startsWith('~/')) return join(homedir(), value.slice(2));
    if (isAbsolute(value)) return value;
    return value;
}
