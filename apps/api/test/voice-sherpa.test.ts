import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type Logger from '../src/common/log.js';
import type { VoiceModelStore } from '../src/voice/models.js';
import {
    buildOnlineRecognizerConfig,
    discoverModelFiles,
    pcm16leToFloat32,
    probeSherpaNode,
    toPcmBytes,
} from '../src/voice/sherpa-engine.js';
import { SherpaHost } from '../src/voice/sherpa-host.js';

const SHERPA_ENV = 'MAZI_VOICE_SHERPA_NODE_PATH';
const DEFAULT_MODEL_ID = 'sherpa-streaming-small-bilingual-zh-en';

const silentLogger = {
    log: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
    error: () => undefined,
} as unknown as Logger;

const tempDirs: string[] = [];
let originalEnv: string | undefined;

function tempDir(prefix = 'mazi-voice-sherpa-'): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function restoreEnv(): void {
    if (originalEnv === undefined) delete process.env[SHERPA_ENV];
    else process.env[SHERPA_ENV] = originalEnv;
}

originalEnv = process.env[SHERPA_ENV];

afterEach(() => {
    restoreEnv();
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function fakeModelStore(overrides: Partial<VoiceModelStore> = {}): VoiceModelStore {
    return {
        list: () => [],
        installed: () => false,
        modelDir: (id: string) => join(tmpdir(), 'mazi-voice-fake-models', id),
        startDownload: () => ({ jobId: 'fake-job' }),
        downloadStatus: () => undefined,
        ...overrides,
    };
}

/** 构造一个空壳 sherpa-onnx-node 包目录（只用于探测，不真正 require）。 */
function fakeSherpaPackage(base: string): string {
    const dir = join(base, 'sherpa-onnx-node');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'sherpa-onnx-node', version: '0.0.0-test', main: 'index.js' }),
    );
    writeFileSync(join(dir, 'index.js'), 'module.exports = {};\n');
    return dir;
}

function writeModelDir(base: string): string {
    const dir = join(base, 'model');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'encoder-epoch-1.int8.onnx'), 'x');
    writeFileSync(join(dir, 'decoder-epoch-1.onnx'), 'x');
    writeFileSync(join(dir, 'joiner-epoch-1.int8.onnx'), 'x');
    writeFileSync(join(dir, 'tokens.txt'), 'x');
    return dir;
}

describe('sherpa-onnx-node 探测（MAZI_VOICE_SHERPA_NODE_PATH）', () => {
    it('本地包目录不存在时不可用（engine_missing）', () => {
        process.env[SHERPA_ENV] = join(tmpdir(), 'mazi-definitely-missing-sherpa');
        const probe = probeSherpaNode();
        expect(probe.available).toBe(false);
        expect(probe.reason).toBe('engine_missing');
    });

    it('本地包目录存在时可用，specifier 为绝对路径', () => {
        const base = tempDir();
        const pkg = fakeSherpaPackage(base);
        process.env[SHERPA_ENV] = pkg;
        const probe = probeSherpaNode();
        expect(probe.available).toBe(true);
        expect(probe.specifier).toBe(resolve(pkg));
        expect(probe.localPath).toBe(resolve(pkg));
    });
});

describe('SherpaHost.availability', () => {
    it('包缺失 → engine_missing', () => {
        process.env[SHERPA_ENV] = join(tmpdir(), 'mazi-definitely-missing-sherpa');
        const host = new SherpaHost({
            models: fakeModelStore({ installed: () => true }),
            logger: silentLogger,
        });
        expect(host.availability()).toEqual({ available: false, reason: 'engine_missing' });
        host.closeAll();
    });

    it('包可用但默认模型未安装 → model_missing', () => {
        const base = tempDir();
        process.env[SHERPA_ENV] = fakeSherpaPackage(base);
        const host = new SherpaHost({
            models: fakeModelStore({ installed: () => false }),
            logger: silentLogger,
        });
        expect(host.availability()).toEqual({ available: false, reason: 'model_missing' });
        host.closeAll();
    });

    it('包与默认模型都可用 → available', () => {
        const base = tempDir();
        process.env[SHERPA_ENV] = fakeSherpaPackage(base);
        const host = new SherpaHost({
            models: fakeModelStore({ installed: () => true }),
            logger: silentLogger,
        });
        expect(host.availability()).toEqual({ available: true });
        host.closeAll();
    });

    it('closeAll 之后 availability 降级', () => {
        const base = tempDir();
        process.env[SHERPA_ENV] = fakeSherpaPackage(base);
        const host = new SherpaHost({
            models: fakeModelStore({ installed: () => true }),
            logger: silentLogger,
        });
        host.closeAll();
        expect(host.availability()).toEqual({ available: false, reason: 'engine_unavailable' });
    });
});

describe('模型文件扫描与 recognizer 配置（纯逻辑）', () => {
    it('优先选择 int8 encoder/decoder/joiner', async () => {
        const base = tempDir();
        const dir = join(base, 'model');
        mkdirSync(dir, { recursive: true });
        for (const name of [
            'encoder-epoch-1.onnx',
            'encoder-epoch-1.int8.onnx',
            'decoder-epoch-1.onnx',
            'decoder-epoch-1.int8.onnx',
            'joiner-epoch-1.onnx',
            'joiner-epoch-1.int8.onnx',
            'tokens.txt',
        ]) {
            writeFileSync(join(dir, name), 'x');
        }
        const files = await discoverModelFiles(dir);
        expect(files).toEqual({
            encoder: 'encoder-epoch-1.int8.onnx',
            decoder: 'decoder-epoch-1.int8.onnx',
            joiner: 'joiner-epoch-1.int8.onnx',
            tokens: 'tokens.txt',
        });
    });

    it('缺少必需文件 → model_missing', async () => {
        const base = tempDir();
        const dir = join(base, 'model');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'encoder-epoch-1.onnx'), 'x');
        writeFileSync(join(dir, 'decoder-epoch-1.onnx'), 'x');
        writeFileSync(join(dir, 'tokens.txt'), 'x');
        await expect(discoverModelFiles(dir)).rejects.toMatchObject({ code: 'model_missing' });
    });

    it('buildOnlineRecognizerConfig 配置正确', () => {
        const config = buildOnlineRecognizerConfig('/models/demo', {
            encoder: 'encoder.int8.onnx',
            decoder: 'decoder.onnx',
            joiner: 'joiner.int8.onnx',
            tokens: 'tokens.txt',
        });
        expect(config.featConfig).toEqual({ sampleRate: 16000, featureDim: 80 });
        expect(config.modelConfig.transducer).toEqual({
            encoder: join('/models/demo', 'encoder.int8.onnx'),
            decoder: join('/models/demo', 'decoder.onnx'),
            joiner: join('/models/demo', 'joiner.int8.onnx'),
        });
        expect(config.modelConfig.tokens).toBe(join('/models/demo', 'tokens.txt'));
        expect(config.modelConfig.numThreads).toBe(1);
        expect(config.modelConfig.provider).toBe('cpu');
        expect(config.decodingMethod).toBe('greedy_search');
        expect(config.enableEndpoint).toBe(true);
        expect(config.rule1MinTrailingSilence).toBeGreaterThan(0);
        expect(config.rule2MinTrailingSilence).toBeGreaterThan(0);
        expect(config.rule3MinUtteranceLength).toBeGreaterThan(0);
    });
});

describe('PCM 转换', () => {
    it('PCM16LE 转 Float32（/32768）', () => {
        const pcm = new Uint8Array([
            0,
            0, // 0
            255,
            127, // 32767
            0,
            128, // -32768
            0,
            64, // 16384
        ]);
        const samples = pcm16leToFloat32(pcm);
        expect(samples).toHaveLength(4);
        expect(samples[0]).toBe(0);
        expect(samples[1]).toBeCloseTo(32767 / 32768, 6);
        expect(samples[2]).toBe(-1);
        expect(samples[3]).toBe(0.5);
        expect(pcm16leToFloat32(new Uint8Array([1, 2, 3]))).toHaveLength(1);
    });

    it('toPcmBytes 兼容 Uint8Array/Buffer/ArrayBuffer/JSON Buffer', () => {
        const bytes = new Uint8Array([1, 2, 3, 4]);
        expect(Array.from(toPcmBytes(bytes))).toEqual([1, 2, 3, 4]);
        expect(Array.from(toPcmBytes(Buffer.from([5, 6])))).toEqual([5, 6]);
        expect(Array.from(toPcmBytes(bytes.buffer))).toEqual([1, 2, 3, 4]);
        expect(Array.from(toPcmBytes({ type: 'Buffer', data: [7, 8] }))).toEqual([7, 8]);
        expect(toPcmBytes('bad')).toHaveLength(0);
    });
});

describe('SherpaHost 失败路径', () => {
    it('模型未安装时 open 直接 model_missing（不启动子进程）', async () => {
        process.env[SHERPA_ENV] = join(tmpdir(), 'mazi-definitely-missing-sherpa');
        const host = new SherpaHost({
            models: fakeModelStore({ installed: () => false }),
            logger: silentLogger,
            childScript: pathToFileURL(join(tmpdir(), 'mazi-missing-child.js')),
            requestTimeoutMs: 1000,
        });
        await expect(
            host.open({
                sessionId: 's1',
                modelId: DEFAULT_MODEL_ID,
                modelDir: '/tmp/model',
                language: 'zh-CN',
                sampleRate: 16000,
            }),
        ).rejects.toMatchObject({ code: 'model_missing' });
        host.closeAll();
    });

    it('子进程无法启动时 open 失败并降级 availability', async () => {
        const base = tempDir();
        process.env[SHERPA_ENV] = fakeSherpaPackage(base);
        const host = new SherpaHost({
            models: fakeModelStore({
                installed: () => true,
                modelDir: () => writeModelDir(base),
            }),
            logger: silentLogger,
            childScript: pathToFileURL(join(base, 'missing-sherpa-child.js')),
            requestTimeoutMs: 3000,
        });
        await expect(
            host.open({
                sessionId: 's1',
                modelId: DEFAULT_MODEL_ID,
                modelDir: writeModelDir(base),
                language: 'zh-CN',
                sampleRate: 16000,
            }),
        ).rejects.toMatchObject({ code: 'engine_unavailable' });
        expect(host.availability()).toEqual({ available: false, reason: 'engine_unavailable' });
        host.closeAll();
        expect(existsSync(join(base, 'model', 'tokens.txt'))).toBe(true);
    });
});

describe('本地 .tmp-voice 包存在性（可选，不下载模型）', () => {
    const realPackage = join(process.cwd(), '.tmp-voice', 'node_modules', 'sherpa-onnx-node');

    it.skipIf(!existsSync(realPackage))(
        'MAZI_VOICE_SHERPA_NODE_PATH 指向本地包，但模型缺失时仍不可用',
        () => {
            process.env[SHERPA_ENV] = realPackage;
            const host = new SherpaHost({
                models: fakeModelStore({ installed: () => false }),
                logger: silentLogger,
            });
            expect(host.availability()).toEqual({ available: false, reason: 'model_missing' });
            host.closeAll();
        },
    );
});
describe('SherpaHost IPC（fake child，不加载真实模型）', () => {
    function writeFakeChild(base: string, mode: 'normal' | 'crash' | 'silent'): URL {
        const script = join(base, `fake-sherpa-child-${mode}.cjs`);
        const normal = `
process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'open') {
    process.send({ type: 'opened', id: msg.id, sessionId: msg.sessionId });
  } else if (msg.type === 'audio') {
    process.send({ type: 'partial', id: msg.id, sessionId: msg.sessionId, text: 'heard ' + msg.pcm.byteLength });
  } else if (msg.type === 'end') {
    process.send({ type: 'final', id: msg.id, sessionId: msg.sessionId, text: 'hello world', durationMs: 5 });
  } else if (msg.type === 'shutdown') {
    process.exit(0);
  }
});
`;
        const crash = `
process.on('message', (msg) => {
  if (msg && msg.type === 'open') process.send({ type: 'opened', id: msg.id, sessionId: msg.sessionId });
  if (msg && msg.type === 'audio') process.exit(7);
});
`;
        const silent = "process.on('message', () => {});\n";
        writeFileSync(script, mode === 'normal' ? normal : mode === 'crash' ? crash : silent);
        return pathToFileURL(script);
    }

    it('open → push(partial) → end(final) → closeAll', async () => {
        const base = tempDir();
        process.env[SHERPA_ENV] = fakeSherpaPackage(base);
        const host = new SherpaHost({
            models: fakeModelStore({ installed: () => true, modelDir: () => writeModelDir(base) }),
            logger: silentLogger,
            childScript: writeFakeChild(base, 'normal'),
            requestTimeoutMs: 3000,
        });
        const session = await host.open({
            sessionId: 's1',
            modelId: DEFAULT_MODEL_ID,
            modelDir: writeModelDir(base),
            language: 'zh-CN',
            sampleRate: 16000,
        });
        const pushed = await session.push(new Uint8Array([1, 2, 3, 4]));
        expect(pushed.partial).toBe('heard 4');
        const final = await session.end();
        expect(final.text).toBe('hello world');
        host.closeAll();
        expect(host.availability()).toMatchObject({ available: false, reason: 'engine_unavailable' });
    });

    it('child 崩溃：pending 请求 reject，availability 降级后自动重启恢复', async () => {
        const base = tempDir();
        process.env[SHERPA_ENV] = fakeSherpaPackage(base);
        const host = new SherpaHost({
            models: fakeModelStore({ installed: () => true, modelDir: () => writeModelDir(base) }),
            logger: silentLogger,
            childScript: writeFakeChild(base, 'crash'),
            requestTimeoutMs: 3000,
        });
        const session = await host.open({
            sessionId: 's1',
            modelId: DEFAULT_MODEL_ID,
            modelDir: writeModelDir(base),
            language: 'zh-CN',
            sampleRate: 16000,
        });
        await expect(session.push(new Uint8Array([1, 2]))).rejects.toMatchObject({
            code: 'engine_unavailable',
        });
        expect(host.availability()).toEqual({ available: false, reason: 'engine_unavailable' });
        // 指数退避首次 500ms 后自动重启；恢复后 availability 回到可用。
        await new Promise<void>((resolvePromise) => {
            setTimeout(resolvePromise, 800);
        });
        expect(host.availability()).toEqual({ available: true });
        host.closeAll();
    });

    it('child 无响应：open 超时抛 timeout', async () => {
        const base = tempDir();
        process.env[SHERPA_ENV] = fakeSherpaPackage(base);
        const host = new SherpaHost({
            models: fakeModelStore({ installed: () => true, modelDir: () => writeModelDir(base) }),
            logger: silentLogger,
            childScript: writeFakeChild(base, 'silent'),
            requestTimeoutMs: 200,
        });
        await expect(
            host.open({
                sessionId: 's1',
                modelId: DEFAULT_MODEL_ID,
                modelDir: writeModelDir(base),
                language: 'zh-CN',
                sampleRate: 16000,
            }),
        ).rejects.toMatchObject({ code: 'timeout' });
        host.closeAll();
    });
});
