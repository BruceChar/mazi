import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type Logger from '../src/common/log.js';
import {
    SENSEVOICE_FILES,
    SENSEVOICE_MODEL_DIR_ENV,
    type SenseVoiceAsset,
} from '../src/voice/sensevoice/assets.js';
import { SenseVoiceStore } from '../src/voice/sensevoice/store.js';
import type { SenseVoicePaths } from '../src/voice/sensevoice/types.js';

const silentLogger = {
    log: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
    error: () => undefined,
} as unknown as Logger;

const CONTENT: Record<'model' | 'tokens' | 'vad', Buffer> = {
    model: Buffer.from('model-bytes'),
    tokens: Buffer.from('tok'),
    vad: Buffer.from('vad-bytes'),
};

const tempDirs: string[] = [];
const originalEnv = {
    dir: process.env[SENSEVOICE_MODEL_DIR_ENV],
    home: process.env.MAZI_HOME,
};

function tempDir(prefix = 'mazi-sensevoice-'): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function sha256(value: Buffer | string): string {
    return createHash('sha256').update(value).digest('hex');
}

function tinyAssets(): SenseVoiceAsset[] {
    const specs: Array<{ kind: 'model' | 'tokens' | 'vad'; fileName: string }> = [
        { kind: 'model', fileName: SENSEVOICE_FILES.model },
        { kind: 'tokens', fileName: SENSEVOICE_FILES.tokens },
        { kind: 'vad', fileName: SENSEVOICE_FILES.vad },
    ];
    return specs.map(({ kind, fileName }) => ({
        kind,
        fileName,
        url: `https://example.test/${fileName}`,
        sizeBytes: CONTENT[kind].length,
        sha256: sha256(CONTENT[kind]),
    }));
}

function writeAssetFiles(
    dir: string,
    assets: readonly SenseVoiceAsset[],
    contents: Record<'model' | 'tokens' | 'vad', Buffer> = CONTENT,
): void {
    mkdirSync(dir, { recursive: true });
    for (const asset of assets) writeFileSync(join(dir, asset.fileName), contents[asset.kind]);
}

/** DSH 缓存布局：<dshRoot>/speech-to-text/sensevoice/models/{sensevoice-onnx,silero}/... */
function dshCachePaths(dshRoot: string): SenseVoicePaths {
    const models = join(dshRoot, 'speech-to-text', 'sensevoice', 'models');
    return {
        model: join(models, 'sensevoice-onnx', SENSEVOICE_FILES.model),
        tokens: join(models, 'sensevoice-onnx', SENSEVOICE_FILES.tokens),
        vad: join(models, 'silero', SENSEVOICE_FILES.vad),
    };
}

function writeDshCache(
    dshRoot: string,
    contents: Record<'model' | 'tokens' | 'vad', Buffer> = CONTENT,
): SenseVoicePaths {
    const paths = dshCachePaths(dshRoot);
    mkdirSync(join(dshRoot, 'speech-to-text', 'sensevoice', 'models', 'sensevoice-onnx'), {
        recursive: true,
    });
    mkdirSync(join(dshRoot, 'speech-to-text', 'sensevoice', 'models', 'silero'), {
        recursive: true,
    });
    writeFileSync(paths.model, contents.model);
    writeFileSync(paths.tokens, contents.tokens);
    writeFileSync(paths.vad, contents.vad);
    return paths;
}

interface FetchRecorder {
    calls: string[];
    progress: Array<number | undefined>;
}

function fakeFetch(options: {
    store?: () => SenseVoiceStore | undefined;
    recorder?: FetchRecorder;
    status?: number;
    contents?: Record<'model' | 'tokens' | 'vad', Buffer>;
    delayMs?: number;
}): typeof fetch {
    const byFile: Record<string, Buffer> = {
        [SENSEVOICE_FILES.model]: (options.contents ?? CONTENT).model,
        [SENSEVOICE_FILES.tokens]: (options.contents ?? CONTENT).tokens,
        [SENSEVOICE_FILES.vad]: (options.contents ?? CONTENT).vad,
    };
    return (async (input: RequestInfo | URL) => {
        const url = String(input);
        options.recorder?.calls.push(url);
        options.recorder?.progress.push(options.store?.()?.installStatus()?.progress);
        if (options.delayMs) {
            await new Promise<void>((resolvePromise) => {
                setTimeout(resolvePromise, options.delayMs);
            });
        }
        if (options.status && options.status !== 200) {
            return new Response('upstream error', { status: options.status });
        }
        const fileName = url.split('/').pop() ?? '';
        const body = byFile[fileName];
        if (!body) return new Response('not found', { status: 404 });
        return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
}

const rejectFetch = (async () => {
    throw new Error('不应发起模型下载');
}) as unknown as typeof fetch;

afterEach(() => {
    if (originalEnv.dir === undefined) delete process.env[SENSEVOICE_MODEL_DIR_ENV];
    else process.env[SENSEVOICE_MODEL_DIR_ENV] = originalEnv.dir;
    if (originalEnv.home === undefined) delete process.env.MAZI_HOME;
    else process.env.MAZI_HOME = originalEnv.home;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('SenseVoiceStore 安装状态', () => {
    it('三个文件大小正确 → installed/paths/modelInfo', () => {
        const root = tempDir();
        const assets = tinyAssets();
        writeAssetFiles(root, assets);
        const store = new SenseVoiceStore({
            root,
            dshRoot: tempDir(),
            assets,
            logger: silentLogger,
            fetchImpl: rejectFetch,
        });
        expect(store.rootDir()).toBe(resolve(root));
        expect(store.installed()).toBe(true);
        expect(store.paths()).toEqual({
            model: resolve(root, SENSEVOICE_FILES.model),
            tokens: resolve(root, SENSEVOICE_FILES.tokens),
            vad: resolve(root, SENSEVOICE_FILES.vad),
        });
        const info = store.modelInfo();
        expect(info).toMatchObject({
            id: 'sensevoice-small-int8',
            languages: ['zh', 'en', 'yue', 'ja', 'ko'],
            sizeBytes: CONTENT.model.length + CONTENT.tokens.length + CONTENT.vad.length,
            installed: true,
            recommended: true,
        });
        expect(info.license).toBe('Apache-2.0');
        expect(info.licenseUrl).toContain('huggingface.co');
        expect(store.installStatus()).toEqual({
            modelId: 'sensevoice-small-int8',
            status: 'done',
            progress: 1,
        });
    });

    it('文件缺失或大小不对 → 未安装，paths 为 null', () => {
        const root = tempDir();
        const assets = tinyAssets();
        writeAssetFiles(root, assets);
        writeFileSync(join(root, SENSEVOICE_FILES.vad), 'wrong-size');
        const store = new SenseVoiceStore({
            root,
            dshRoot: tempDir(),
            assets,
            logger: silentLogger,
            fetchImpl: rejectFetch,
        });
        expect(store.installed()).toBe(false);
        expect(store.paths()).toBeNull();
        expect(store.modelInfo().installed).toBe(false);
        expect(store.installStatus()).toBeUndefined();
    });

    it('MAZI_VOICE_SENSEVOICE_DIR 优先于 DSH 缓存', () => {
        const assets = tinyAssets();
        const envDir = tempDir();
        writeAssetFiles(envDir, assets);
        const dshRoot = tempDir();
        writeDshCache(dshRoot);
        process.env[SENSEVOICE_MODEL_DIR_ENV] = envDir;
        const store = new SenseVoiceStore({ dshRoot, assets, logger: silentLogger, fetchImpl: rejectFetch });
        expect(store.installed()).toBe(true);
        expect(store.paths()).toEqual({
            model: resolve(envDir, SENSEVOICE_FILES.model),
            tokens: resolve(envDir, SENSEVOICE_FILES.tokens),
            vad: resolve(envDir, SENSEVOICE_FILES.vad),
        });
    });

    it('未设置目录且 DSH 缓存完整 → 只读复用，不下载', async () => {
        delete process.env[SENSEVOICE_MODEL_DIR_ENV];
        const assets = tinyAssets();
        const dshRoot = tempDir();
        const cached = writeDshCache(dshRoot);
        const recorder: FetchRecorder = { calls: [], progress: [] };
        const store = new SenseVoiceStore({
            dshRoot,
            assets,
            logger: silentLogger,
            fetchImpl: fakeFetch({ recorder }),
        });
        expect(store.installed()).toBe(true);
        expect(store.paths()).toEqual(cached);
        await expect(store.ensureInstalled()).resolves.toEqual({
            modelId: 'sensevoice-small-int8',
            status: 'done',
            progress: 1,
        });
        expect(recorder.calls).toHaveLength(0);
    });

    it('DSH 缓存不完整 → 下载到 $MAZI_HOME/voice/models/<id>', async () => {
        delete process.env[SENSEVOICE_MODEL_DIR_ENV];
        const home = tempDir();
        process.env.MAZI_HOME = home;
        const assets = tinyAssets();
        const dshRoot = tempDir();
        const cached = writeDshCache(dshRoot);
        writeFileSync(cached.model, 'truncated');
        const recorder: FetchRecorder = { calls: [], progress: [] };
        const store = new SenseVoiceStore({
            dshRoot,
            assets,
            logger: silentLogger,
            fetchImpl: fakeFetch({ recorder }),
        });
        expect(store.installed()).toBe(false);
        expect(store.paths()).toBeNull();
        const status = await store.ensureInstalled();
        expect(status).toEqual({
            modelId: 'sensevoice-small-int8',
            status: 'done',
            progress: 1,
        });
        const localRoot = join(home, 'voice', 'models', 'sensevoice-small-int8');
        expect(store.paths()).toEqual({
            model: resolve(localRoot, SENSEVOICE_FILES.model),
            tokens: resolve(localRoot, SENSEVOICE_FILES.tokens),
            vad: resolve(localRoot, SENSEVOICE_FILES.vad),
        });
        expect(readFileSync(join(localRoot, SENSEVOICE_FILES.model))).toEqual(CONTENT.model);
        // DSH 缓存是只读的：不补写/不覆盖。
        expect(readFileSync(cached.model, 'utf8')).toBe('truncated');
        expect(recorder.calls).toHaveLength(3);
    });
});

describe('SenseVoiceStore 下载安装', () => {
    function newStore(options: {
        root: string;
        assets: readonly SenseVoiceAsset[];
        fetchImpl: typeof fetch;
        recorder?: FetchRecorder;
    }): SenseVoiceStore {
        return new SenseVoiceStore({
            root: options.root,
            dshRoot: tempDir(),
            assets: options.assets,
            logger: silentLogger,
            fetchImpl: options.fetchImpl,
        });
    }

    it('逐个下载 → 校验 → 原子安装，进度 0-1', async () => {
        const root = tempDir();
        const assets = tinyAssets();
        const recorder: FetchRecorder = { calls: [], progress: [] };
        let store: SenseVoiceStore | undefined;
        const fetchImpl = fakeFetch({ store: () => store, recorder });
        store = new SenseVoiceStore({
            root,
            dshRoot: tempDir(),
            assets,
            logger: silentLogger,
            fetchImpl,
        });
        const status = await store.ensureInstalled();
        expect(status).toEqual({
            modelId: 'sensevoice-small-int8',
            status: 'done',
            progress: 1,
        });
        expect(recorder.calls).toHaveLength(3);
        expect(recorder.calls.map((url) => url.split('/').pop())).toEqual([
            SENSEVOICE_FILES.model,
            SENSEVOICE_FILES.tokens,
            SENSEVOICE_FILES.vad,
        ]);
        expect(recorder.progress[0]).toBe(0);
        const total = CONTENT.model.length + CONTENT.tokens.length + CONTENT.vad.length;
        expect(recorder.progress[1]).toBeCloseTo(CONTENT.model.length / total, 6);
        expect(recorder.progress[2]).toBeCloseTo(
            (CONTENT.model.length + CONTENT.tokens.length) / total,
            6,
        );
        expect(readFileSync(join(root, SENSEVOICE_FILES.model))).toEqual(CONTENT.model);
        expect(readFileSync(join(root, SENSEVOICE_FILES.tokens))).toEqual(CONTENT.tokens);
        expect(readFileSync(join(root, SENSEVOICE_FILES.vad))).toEqual(CONTENT.vad);
        expect(store.installed()).toBe(true);
        expect(readdirSync(root).filter((name) => name.includes('.part-'))).toHaveLength(0);
    });

    it('并发调用复用进行中的安装任务（fetch 只跑一遍）', async () => {
        const root = tempDir();
        const assets = tinyAssets();
        const recorder: FetchRecorder = { calls: [], progress: [] };
        const store = new SenseVoiceStore({
            root,
            dshRoot: tempDir(),
            assets,
            logger: silentLogger,
            fetchImpl: fakeFetch({ recorder, delayMs: 10 }),
        });
        const [first, second] = await Promise.all([
            store.ensureInstalled(),
            store.ensureInstalled(),
        ]);
        expect(first.status).toBe('done');
        expect(second.status).toBe('done');
        expect(recorder.calls).toHaveLength(3);
    });

    it('已安装时 ensureInstalled 直接 done，不再下载', async () => {
        const root = tempDir();
        const assets = tinyAssets();
        writeAssetFiles(root, assets);
        const recorder: FetchRecorder = { calls: [], progress: [] };
        const store = new SenseVoiceStore({
            root,
            dshRoot: tempDir(),
            assets,
            logger: silentLogger,
            fetchImpl: fakeFetch({ recorder }),
        });
        const status = await store.ensureInstalled();
        expect(status.status).toBe('done');
        expect(recorder.calls).toHaveLength(0);
    });

    it('部分文件已存在 → 只补下缺失文件', async () => {
        const root = tempDir();
        const assets = tinyAssets();
        writeAssetFiles(root, assets.slice(0, 2));
        const recorder: FetchRecorder = { calls: [], progress: [] };
        const store = new SenseVoiceStore({
            root,
            dshRoot: tempDir(),
            assets,
            logger: silentLogger,
            fetchImpl: fakeFetch({ recorder }),
        });
        const status = await store.ensureInstalled();
        expect(status.status).toBe('done');
        expect(recorder.calls.map((url) => url.split('/').pop())).toEqual([SENSEVOICE_FILES.vad]);
        expect(store.installed()).toBe(true);
    });

    it('HTTP 失败 → error 状态，清理临时文件', async () => {
        const root = tempDir();
        const status = await newStore({
            root,
            assets: tinyAssets(),
            fetchImpl: fakeFetch({ status: 500 }),
        }).ensureInstalled();
        expect(status.status).toBe('error');
        expect(status.error).toContain('HTTP 500');
        expect(readdirSync(root).filter((name) => name.includes('.part-'))).toHaveLength(0);
    });

    it('大小校验失败 → error 状态', async () => {
        const root = tempDir();
        const contents = { ...CONTENT, model: Buffer.from('x') };
        const status = await newStore({
            root,
            assets: tinyAssets(),
            fetchImpl: fakeFetch({ contents }),
        }).ensureInstalled();
        expect(status.status).toBe('error');
        expect(status.error).toContain('大小校验失败');
        expect(readdirSync(root).filter((name) => name.includes('.part-'))).toHaveLength(0);
    });

    it('sha256 校验失败 → error 状态', async () => {
        const root = tempDir();
        const contents = { ...CONTENT, model: Buffer.from('MODEL-BYTES') };
        const status = await newStore({
            root,
            assets: tinyAssets(),
            fetchImpl: fakeFetch({ contents }),
        }).ensureInstalled();
        expect(status.status).toBe('error');
        expect(status.error).toContain('sha256');
        expect(readdirSync(root).filter((name) => name.includes('.part-'))).toHaveLength(0);
    });

    it('失败后重试可成功（幂等）', async () => {
        const root = tempDir();
        const assets = tinyAssets();
        const failing = newStore({
            root,
            assets,
            fetchImpl: fakeFetch({ status: 500 }),
        });
        expect((await failing.ensureInstalled()).status).toBe('error');
        const recovering = newStore({ root, assets, fetchImpl: fakeFetch({}) });
        const status = await recovering.ensureInstalled();
        expect(status.status).toBe('done');
        expect(recovering.installed()).toBe(true);
    });
});
