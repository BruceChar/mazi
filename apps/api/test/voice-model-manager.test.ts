import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type Logger from '../src/common/log.js';
import {
    ModelManager,
    VoiceModelError,
    defaultModelRoot,
    isSafeArchivePath,
    matchFilePattern,
} from '../src/voice/model-manager.js';
import type { VoiceModelDefinition } from '../src/voice/models.js';

const MODEL_FILES: Record<string, string> = {
    'encoder-epoch-99-avg-1.int8.onnx': 'encoder',
    'decoder-epoch-99-avg-1.onnx': 'decoder',
    'joiner-epoch-99-avg-1.int8.onnx': 'joiner',
    'tokens.txt': 'tokens',
};

const silentLogger = {
    log: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
    error: () => undefined,
} as unknown as Logger;

const tempDirs: string[] = [];

function tempDir(prefix = 'mazi-voice-model-'): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function makeModel(
    id: string,
    overrides: Partial<VoiceModelDefinition> = {},
): VoiceModelDefinition {
    return {
        id,
        name: id,
        description: '',
        languages: ['zh', 'en'],
        sizeBytes: 1024,
        license: 'Apache-2.0',
        licenseUrl: 'https://example.invalid/LICENSE',
        url: 'https://example.invalid/model.tar.bz2',
        files: [
            { pattern: '*encoder*.onnx', required: true },
            { pattern: '*decoder*.onnx', required: true },
            { pattern: '*joiner*.onnx', required: true },
            { pattern: 'tokens.txt', required: true },
        ],
        recommended: false,
        ...overrides,
    };
}

/** 构造一个真实的小 tar.bz2（依赖系统 tar），避免测试下载 48MB 模型。 */
function buildTarBz2(base: string, files: Record<string, string> = MODEL_FILES): string {
    const source = join(base, 'fixture');
    mkdirSync(source, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(source, name), content);
    }
    const archive = join(base, 'fixture.tar.bz2');
    execFileSync('tar', ['-cjf', archive, '-C', source, '.'], { stdio: 'ignore' });
    return archive;
}

function responseFromFile(path: string): Response {
    const bytes = readFileSync(path);
    return new Response(new Uint8Array(bytes));
}

function fetchFromBytes(bytes: Uint8Array): typeof fetch {
    return (async () => new Response(bytes)) as unknown as typeof fetch;
}

describe('defaultModelRoot（MAZI_HOME / MAZI_VOICE_MODEL_DIR）', () => {
    it('MAZI_HOME 缺省 ~/.mazi，voice/models 子目录', () => {
        expect(defaultModelRoot({})).toBe(join(homedir(), '.mazi', 'voice', 'models'));
        expect(defaultModelRoot({ MAZI_HOME: '/tmp/mazi-home' })).toBe(
            join('/tmp/mazi-home', 'voice', 'models'),
        );
    });

    it('MAZI_VOICE_MODEL_DIR 优先且支持 ~ 展开', () => {
        expect(
            defaultModelRoot({
                MAZI_HOME: '/tmp/mazi-home',
                MAZI_VOICE_MODEL_DIR: '~/voice-models',
            }),
        ).toBe(join(homedir(), 'voice-models'));
        expect(defaultModelRoot({ MAZI_VOICE_MODEL_DIR: '/tmp/x/models' })).toBe(
            '/tmp/x/models',
        );
    });
});

describe('模型安装状态与列表', () => {
    it('installed 校验注册表声明的必需文件；list 反映安装状态', () => {
        const base = tempDir();
        const root = join(base, 'voice', 'models');
        const modelDir = join(root, 'm1');
        mkdirSync(modelDir, { recursive: true });
        for (const name of Object.keys(MODEL_FILES)) {
            writeFileSync(join(modelDir, name), 'x');
        }
        const manager = new ModelManager({
            root,
            logger: silentLogger,
            models: [makeModel('m1'), makeModel('m2')],
        });
        expect(manager.installed('m1')).toBe(true);
        expect(manager.installed('m2')).toBe(false);
        expect(manager.installed('missing-id')).toBe(false);
        expect(manager.modelDir('m1')).toBe(modelDir);
        const list = manager.list();
        expect(list.map((info) => [info.id, info.installed])).toEqual([
            ['m1', true],
            ['m2', false],
        ]);
        rmSync(join(modelDir, 'tokens.txt'));
        expect(manager.installed('m1')).toBe(false);
    });

    it('未知模型不暴露路径、删除操作不触碰模型根之外的文件', async () => {
        const base = tempDir();
        const root = join(base, 'voice', 'models');
        mkdirSync(root, { recursive: true });
        const outside = join(base, 'precious');
        mkdirSync(outside);
        writeFileSync(join(outside, 'keep.txt'), 'keep');
        const manager = new ModelManager({
            root,
            logger: silentLogger,
            models: [makeModel('known')],
        });
        expect(() => manager.modelDir('unknown')).toThrow(VoiceModelError);
        expect(() => manager.startDownload('unknown')).toThrow(/未知语音模型/);
        await manager.remove('..');
        await manager.remove('../../precious');
        await manager.remove('unknown');
        expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
    });
});

describe('归档安全与通配匹配', () => {
    it('拒绝绝对路径/.. 段/NUL/盘符', () => {
        expect(isSafeArchivePath('model/tokens.txt')).toBe(true);
        expect(isSafeArchivePath('./model/encoder.onnx')).toBe(true);
        expect(isSafeArchivePath('/etc/passwd')).toBe(false);
        expect(isSafeArchivePath('../evil')).toBe(false);
        expect(isSafeArchivePath('a/../../b')).toBe(false);
        expect(isSafeArchivePath('C:\\windows\\x')).toBe(false);
        expect(isSafeArchivePath('')).toBe(false);
    });

    it('简单 * 通配', () => {
        expect(matchFilePattern('*encoder*.onnx', 'encoder-epoch-1.int8.onnx')).toBe(true);
        expect(matchFilePattern('*encoder*.onnx', 'tokens.txt')).toBe(false);
        expect(matchFilePattern('tokens.txt', 'tokens.txt')).toBe(true);
        expect(matchFilePattern('tokens.txt', 'tokens.txt.bak')).toBe(false);
    });
});

describe('下载 → 解压 → 校验 → 安装', () => {
    it('安装模型、写 models.json（sha256/安装时间/许可）、清理临时目录', async () => {
        const base = tempDir();
        const root = join(base, 'voice', 'models');
        const archive = buildTarBz2(base);
        const model = makeModel('m1');
        const manager = new ModelManager({
            root,
            logger: silentLogger,
            models: [model],
            fetchImpl: fetchFromBytes(new Uint8Array(readFileSync(archive))),
        });
        const { jobId } = manager.startDownload(model.id);
        const status = await manager.waitForDownload(jobId);
        expect(status.status).toBe('done');
        expect(status.progress).toBe(1);
        expect(status.bytesReceived).toBeGreaterThan(0);
        expect(manager.installed(model.id)).toBe(true);
        const target = manager.modelDir(model.id);
        for (const name of Object.keys(MODEL_FILES)) {
            expect(existsSync(join(target, name))).toBe(true);
        }
        const manifest = JSON.parse(
            readFileSync(join(base, 'voice', 'models.json'), 'utf8'),
        ) as {
            models: Record<
                string,
                { id: string; sha256: string; license: string; installedAt: string }
            >;
        };
        expect(manifest.models[model.id]).toMatchObject({
            id: model.id,
            license: 'Apache-2.0',
        });
        expect(manifest.models[model.id].sha256).toBe(
            createHash('sha256').update(readFileSync(archive)).digest('hex'),
        );
        expect(Number.isNaN(Date.parse(manifest.models[model.id].installedAt))).toBe(false);
        expect(readdirSync(root).filter((name) => name.startsWith('.download-'))).toEqual([]);
    });

    it('重复调用进行中的下载返回同一 jobId；并发上限为 1', async () => {
        const base = tempDir();
        const root = join(base, 'voice', 'models');
        const archive = buildTarBz2(base);
        const bytes = new Uint8Array(readFileSync(archive));
        let active = 0;
        let maxActive = 0;
        const fetchImpl = (async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise<void>((resolvePromise) => {
                setTimeout(resolvePromise, 30);
            });
            active -= 1;
            return new Response(bytes);
        }) as unknown as typeof fetch;
        const manager = new ModelManager({
            root,
            logger: silentLogger,
            models: [makeModel('m1'), makeModel('m2')],
            fetchImpl,
        });
        const first = manager.startDownload('m1').jobId;
        expect(manager.startDownload('m1').jobId).toBe(first);
        const second = manager.startDownload('m2').jobId;
        const [statusA, statusB] = await Promise.all([
            manager.waitForDownload(first),
            manager.waitForDownload(second),
        ]);
        expect(statusA.status).toBe('done');
        expect(statusB.status).toBe('done');
        expect(maxActive).toBe(1);
        expect(manager.installed('m1')).toBe(true);
        expect(manager.installed('m2')).toBe(true);
    });

    it('下载失败时 job 标记 error 且不留下安装目录/临时目录', async () => {
        const base = tempDir();
        const root = join(base, 'voice', 'models');
        const model = makeModel('m1');
        const manager = new ModelManager({
            root,
            logger: silentLogger,
            models: [model],
            fetchImpl: (async () => {
                throw new Error('offline');
            }) as unknown as typeof fetch,
        });
        const { jobId } = manager.startDownload(model.id);
        const status = await manager.waitForDownload(jobId);
        expect(status.status).toBe('error');
        expect(status.error).toContain('下载失败');
        expect(manager.installed(model.id)).toBe(false);
        expect(existsSync(manager.modelDir(model.id))).toBe(false);
        expect(
            readdirSync(root).filter((name) => name.startsWith('.download-')),
        ).toEqual([]);
        // 失败后允许重试：用可用的 fetch 再启动一次并安装成功。
        const archive = buildTarBz2(base);
        const retryManager = new ModelManager({
            root,
            logger: silentLogger,
            models: [model],
            fetchImpl: fetchFromBytes(new Uint8Array(readFileSync(archive))),
        });
        const retry = await retryManager.waitForDownload(
            retryManager.startDownload(model.id).jobId,
        );
        expect(retry.status).toBe('done');
        expect(retryManager.installed(model.id)).toBe(true);
    });

it('下载进行中删除模型：取消下载且不留下安装目录', async () => {
        const base = tempDir();
        const root = join(base, 'voice', 'models');
        const archive = buildTarBz2(base);
        const bytes = new Uint8Array(readFileSync(archive));
        let release!: () => void;
        const gate = new Promise<void>((resolvePromise) => {
            release = resolvePromise;
        });
        const model = makeModel('m1');
        const manager = new ModelManager({
            root,
            logger: silentLogger,
            models: [model],
            fetchImpl: (async () => {
                await gate;
                return new Response(bytes);
            }) as unknown as typeof fetch,
        });
        const { jobId } = manager.startDownload(model.id);
        await new Promise<void>((resolvePromise) => {
            setTimeout(resolvePromise, 10);
        });
        await manager.remove(model.id);
        release();
        const status = await manager.waitForDownload(jobId);
        expect(status.status).toBe('error');
        expect(manager.installed(model.id)).toBe(false);
        expect(existsSync(manager.modelDir(model.id))).toBe(false);
    });

    it('已安装模型的删除：移除目录与清单记录', async () => {
        const base = tempDir();
        const root = join(base, 'voice', 'models');
        const archive = buildTarBz2(base);
        const model = makeModel('m1');
        const manager = new ModelManager({
            root,
            logger: silentLogger,
            models: [model],
            fetchImpl: fetchFromBytes(new Uint8Array(readFileSync(archive))),
        });
        await manager.waitForDownload(manager.startDownload(model.id).jobId);
        expect(manager.installed(model.id)).toBe(true);
        await manager.remove(model.id);
        expect(manager.installed(model.id)).toBe(false);
        expect(existsSync(manager.modelDir(model.id))).toBe(false);
        const manifest = JSON.parse(
            readFileSync(join(base, 'voice', 'models.json'), 'utf8'),
        ) as { models: Record<string, unknown> };
        expect(manifest.models[model.id]).toBeUndefined();
    });
});