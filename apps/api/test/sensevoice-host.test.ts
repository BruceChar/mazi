import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type Logger from '../src/common/log.js';
import { SenseVoiceHost } from '../src/voice/sensevoice/host.js';
import type { SenseVoiceModelStore } from '../src/voice/sensevoice/types.js';

const SHERPA_ENV = 'MAZI_VOICE_SHERPA_NODE_PATH';

const silentLogger = {
    log: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
    error: () => undefined,
} as unknown as Logger;

const tempDirs: string[] = [];
const hosts: SenseVoiceHost[] = [];
let originalEnv: string | undefined = process.env[SHERPA_ENV];

function tempDir(prefix = 'mazi-sensevoice-host-'): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolvePromise) => {
        setTimeout(resolvePromise, ms);
    });
}

/** 空壳 sherpa-onnx-node 包目录（只用于 probe，不真正 require）。 */
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

function fakeStore(overrides: Partial<SenseVoiceModelStore> = {}): SenseVoiceModelStore {
    const paths = {
        model: join(tmpdir(), 'mazi-sensevoice-fake', 'model.int8.onnx'),
        tokens: join(tmpdir(), 'mazi-sensevoice-fake', 'tokens.txt'),
        vad: join(tmpdir(), 'mazi-sensevoice-fake', 'silero_vad.onnx'),
    };
    return {
        installed: () => true,
        paths: () => paths,
        modelInfo: () => ({
            id: 'sensevoice-small-int8',
            name: 'SenseVoice Small',
            description: '',
            languages: ['zh', 'en', 'yue', 'ja', 'ko'],
            sizeBytes: 1,
            license: 'Apache-2.0',
            installed: true,
            recommended: true,
        }),
        installStatus: () => undefined,
        ensureInstalled: async () => ({
            modelId: 'sensevoice-small-int8',
            status: 'done',
            progress: 1,
        }),
        close: () => undefined,
        ...overrides,
    };
}

/** fake child 脚本（.cjs）：不加载真实模型。 */
function writeFakeChild(base: string, mode: 'normal' | 'crash' | 'silent'): URL {
    const script = join(base, `fake-sensevoice-child-${mode}.cjs`);
    const normal = `
process.send({ type: 'ready' });
process.on('disconnect', () => process.exit(0));
process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'transcribe') {
    const len = msg.pcm && msg.pcm.byteLength !== undefined ? msg.pcm.byteLength : -1;
    process.send({ type: 'result', id: msg.id, text: 'hello ' + len, inferenceMs: 12 });
  } else if (msg.type === 'shutdown') {
    process.exit(0);
  }
});
`;
    const crash = `
process.send({ type: 'ready' });
process.on('disconnect', () => process.exit(0));
process.on('message', (msg) => {
  if (msg && msg.type === 'transcribe') process.exit(7);
});
`;
    const silent = `
process.send({ type: 'ready' });
process.on('disconnect', () => process.exit(0));
process.on('message', () => {});
`;
    writeFileSync(script, mode === 'normal' ? normal : mode === 'crash' ? crash : silent);
    return pathToFileURL(script);
}

function newHost(options: ConstructorParameters<typeof SenseVoiceHost>[0]): SenseVoiceHost {
    const host = new SenseVoiceHost(options);
    hosts.push(host);
    return host;
}

afterEach(() => {
    for (const host of hosts.splice(0)) host.closeAll();
    if (originalEnv === undefined) delete process.env[SHERPA_ENV];
    else process.env[SHERPA_ENV] = originalEnv;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('SenseVoiceHost.availability', () => {
    it('sherpa-onnx-node 缺失 → engine_missing', () => {
        process.env[SHERPA_ENV] = join(tmpdir(), 'mazi-definitely-missing-sherpa');
        const host = newHost({ store: fakeStore(), logger: silentLogger });
        expect(host.availability()).toEqual({ available: false, reason: 'engine_missing' });
    });

    it('引擎可用但模型未安装 → model_missing', () => {
        process.env[SHERPA_ENV] = fakeSherpaPackage(tempDir());
        const host = newHost({
            store: fakeStore({ installed: () => false, paths: () => null }),
            logger: silentLogger,
        });
        expect(host.availability()).toEqual({ available: false, reason: 'model_missing' });
    });

    it('引擎与模型都可用 → available', () => {
        process.env[SHERPA_ENV] = fakeSherpaPackage(tempDir());
        const host = newHost({ store: fakeStore(), logger: silentLogger });
        expect(host.availability()).toEqual({ available: true });
    });

    it('closeAll 之后降级为 engine_unavailable', () => {
        process.env[SHERPA_ENV] = fakeSherpaPackage(tempDir());
        const host = newHost({ store: fakeStore(), logger: silentLogger });
        host.closeAll();
        expect(host.availability()).toEqual({ available: false, reason: 'engine_unavailable' });
    });
});

describe('SenseVoiceHost.transcribe', () => {
    it('整段 PCM → child 返回文本与耗时', async () => {
        const base = tempDir();
        process.env[SHERPA_ENV] = fakeSherpaPackage(base);
        const host = newHost({
            store: fakeStore(),
            logger: silentLogger,
            childScript: writeFakeChild(base, 'normal'),
            requestTimeoutMs: 5000,
        });
        const result = await host.transcribe({
            pcm: new Uint8Array([1, 2, 3, 4]),
            sampleRate: 16000,
            language: 'zh',
        });
        expect(result).toEqual({ text: 'hello 4', inferenceMs: 12 });
    });

    it('并发转写按顺序串行完成', async () => {
        const base = tempDir();
        process.env[SHERPA_ENV] = fakeSherpaPackage(base);
        const host = newHost({
            store: fakeStore(),
            logger: silentLogger,
            childScript: writeFakeChild(base, 'normal'),
            requestTimeoutMs: 5000,
        });
        const results = await Promise.all([
            host.transcribe({ pcm: new Uint8Array([1, 2]), sampleRate: 16000, language: 'auto' }),
            host.transcribe({ pcm: new Uint8Array([1, 2, 3]), sampleRate: 16000, language: 'auto' }),
        ]);
        expect(results).toEqual([
            { text: 'hello 2', inferenceMs: 12 },
            { text: 'hello 3', inferenceMs: 12 },
        ]);
    });

    it('child 无响应 → timeout', async () => {
        const base = tempDir();
        process.env[SHERPA_ENV] = fakeSherpaPackage(base);
        const host = newHost({
            store: fakeStore(),
            logger: silentLogger,
            childScript: writeFakeChild(base, 'silent'),
            requestTimeoutMs: 250,
        });
        await expect(
            host.transcribe({
                pcm: new Uint8Array([1, 2]),
                sampleRate: 16000,
                language: 'auto',
            }),
        ).rejects.toMatchObject({ code: 'timeout' });
    });

    it('child 崩溃 → reject 并降级，自动重启后恢复', async () => {
        const base = tempDir();
        process.env[SHERPA_ENV] = fakeSherpaPackage(base);
        const host = newHost({
            store: fakeStore(),
            logger: silentLogger,
            childScript: writeFakeChild(base, 'crash'),
            requestTimeoutMs: 3000,
        });
        await expect(
            host.transcribe({
                pcm: new Uint8Array([1, 2]),
                sampleRate: 16000,
                language: 'auto',
            }),
        ).rejects.toMatchObject({ code: 'engine_unavailable' });
        expect(host.availability()).toEqual({ available: false, reason: 'engine_unavailable' });
        // 指数退避首次 500ms 后自动重启；恢复后 availability 回到可用。
        await sleep(800);
        expect(host.availability()).toEqual({ available: true });
    });

    it('模型未安装时 transcribe 直接 model_missing（不启动子进程）', async () => {
        process.env[SHERPA_ENV] = fakeSherpaPackage(tempDir());
        const host = newHost({
            store: fakeStore({ installed: () => false, paths: () => null }),
            logger: silentLogger,
            childScript: pathToFileURL(join(tmpdir(), 'mazi-missing-sensevoice-child.cjs')),
            requestTimeoutMs: 1000,
        });
        await expect(
            host.transcribe({
                pcm: new Uint8Array([1, 2]),
                sampleRate: 16000,
                language: 'auto',
            }),
        ).rejects.toMatchObject({ code: 'model_missing' });
    });

    it('引擎缺失时 transcribe 直接 engine_unavailable', async () => {
        process.env[SHERPA_ENV] = join(tmpdir(), 'mazi-definitely-missing-sherpa');
        const host = newHost({
            store: fakeStore(),
            logger: silentLogger,
            requestTimeoutMs: 1000,
        });
        await expect(
            host.transcribe({
                pcm: new Uint8Array([1, 2]),
                sampleRate: 16000,
                language: 'auto',
            }),
        ).rejects.toMatchObject({ code: 'engine_unavailable' });
    });

    it('空音频 → bad_request', async () => {
        process.env[SHERPA_ENV] = fakeSherpaPackage(tempDir());
        const host = newHost({ store: fakeStore(), logger: silentLogger, requestTimeoutMs: 1000 });
        await expect(
            host.transcribe({ pcm: new Uint8Array(0), sampleRate: 16000, language: 'auto' }),
        ).rejects.toMatchObject({ code: 'bad_request' });
    });
});
