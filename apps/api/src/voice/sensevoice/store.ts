import { createHash, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { VoiceInstallStatus, VoiceModelInfo } from '@mazi/libs';
import Logger from '../../common/log.js';
import {
    defaultSenseVoiceModelDir,
    expandHomePath,
    SENSEVOICE_ASSETS,
    SENSEVOICE_FILES,
    SENSEVOICE_LANGUAGES,
    SENSEVOICE_LICENSE,
    SENSEVOICE_LICENSE_URL,
    SENSEVOICE_MODEL_DESCRIPTION,
    SENSEVOICE_MODEL_DIR_ENV,
    SENSEVOICE_MODEL_ID,
    SENSEVOICE_MODEL_NAME,
    type SenseVoiceAsset,
    type SenseVoiceAssetKind,
} from './assets.js';
import type { SenseVoiceModelStore, SenseVoicePaths } from './types.js';

const ASSET_KINDS: readonly SenseVoiceAssetKind[] = ['model', 'tokens', 'vad'];

/** DSH 缓存布局（只读复用，不复制）：<dsh>/speech-to-text/sensevoice/models/... */
const DSH_SENSEVOICE_MODELS_DIR = ['speech-to-text', 'sensevoice', 'models'] as const;

export interface SenseVoiceStoreOptions {
    /** 模型目录；缺省优先 MAZI_VOICE_SENSEVOICE_DIR，其次 DSH 缓存，最后 $MAZI_HOME/voice/models/<id>。 */
    root?: string;
    /** DSH 缓存根目录（缺省 ~/.dsh）；测试可注入临时目录。 */
    dshRoot?: string;
    logger?: Logger;
    /** 测试注入：替换资产清单（url / size / sha）。 */
    assets?: readonly SenseVoiceAsset[];
    /** 测试注入：替换 fetch。 */
    fetchImpl?: typeof fetch;
}

/**
 * SenseVoice 模型管理（SenseVoiceSmall int8 + Silero VAD）。
 *
 * 安装策略：
 * - 本机已有 DSH 缓存（~/.dsh/speech-to-text/sensevoice/models）且文件大小正确时直接只读复用，
 *   通用用户无需重复下载 239MB；
 * - MAZI_VOICE_SENSEVOICE_DIR 显式指定模型目录时只使用该目录（不再回退 DSH 缓存）；
 * - 否则逐个下载到 <root>/*.part-<pid>-<uuid>，校验 size + sha256 后原子 rename。
 *
 * 不记录音频/文本；错误信息只包含文件与 HTTP 状态。
 */
export class SenseVoiceStore implements SenseVoiceModelStore {
    private readonly root: string;
    private readonly dshRoot: string;
    /** 未显式指定模型目录时才允许复用 DSH 缓存。 */
    private readonly useDshCache: boolean;
    private readonly assets: readonly SenseVoiceAsset[];
    private readonly logger: Logger;
    private readonly fetchImpl: typeof fetch;
    private installTask: Promise<VoiceInstallStatus> | null = null;
    private status: VoiceInstallStatus | null = null;

    constructor(options: SenseVoiceStoreOptions = {}) {
        const envRoot = process.env[SENSEVOICE_MODEL_DIR_ENV]?.trim();
        const explicitRoot = options.root?.trim();
        const configuredRoot =
            explicitRoot && explicitRoot.length > 0
                ? explicitRoot
                : envRoot && envRoot.length > 0
                  ? envRoot
                  : undefined;
        this.useDshCache = configuredRoot === undefined;
        this.root =
            configuredRoot !== undefined
                ? resolve(expandHomePath(configuredRoot))
                : defaultSenseVoiceModelDir();
        const dshRoot = options.dshRoot?.trim();
        this.dshRoot =
            dshRoot && dshRoot.length > 0
                ? resolve(expandHomePath(dshRoot))
                : join(homedir(), '.dsh');
        this.assets = options.assets ?? SENSEVOICE_ASSETS;
        this.logger = options.logger ?? new Logger('voice-sensevoice');
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
        for (const kind of ASSET_KINDS) {
            if (!this.assets.some((asset) => asset.kind === kind)) {
                throw new Error(`SenseVoice 资产清单缺少 ${kind} 文件`);
            }
        }
    }

    /** 模型目录（绝对路径；测试/日志用）。 */
    rootDir(): string {
        return this.root;
    }

    installed(): boolean {
        return this.paths() !== null;
    }

    /** 可用文件路径（绝对路径）；未安装/不完整时返回 null。 */
    paths(): SenseVoicePaths | null {
        if (this.useDshCache) {
            const cached = this.dshCachePaths();
            if (this.isComplete(cached)) return cached;
        }
        const local = this.localPaths();
        return this.isComplete(local) ? local : null;
    }

    modelInfo(): VoiceModelInfo {
        return {
            id: SENSEVOICE_MODEL_ID,
            name: SENSEVOICE_MODEL_NAME,
            description: SENSEVOICE_MODEL_DESCRIPTION,
            languages: [...SENSEVOICE_LANGUAGES],
            sizeBytes: this.totalSizeBytes(),
            license: SENSEVOICE_LICENSE,
            licenseUrl: SENSEVOICE_LICENSE_URL,
            installed: this.installed(),
            recommended: true,
        };
    }

    installStatus(): VoiceInstallStatus | undefined {
        if (this.installed()) return doneStatus();
        if (this.status && this.status.status !== 'done') return { ...this.status };
        return undefined;
    }

    /**
     * 确保模型可用：已安装（含 DSH 缓存）直接 done；否则串行下载缺失文件。
     * 幂等：并发的 ensureInstalled 复用同一个进行中的 Promise。
     */
    ensureInstalled(): Promise<VoiceInstallStatus> {
        if (this.installed()) return Promise.resolve(doneStatus());
        if (this.installTask) return this.installTask;
        const task = this.runInstall();
        this.installTask = task;
        task.then(
            () => {
                if (this.installTask === task) this.installTask = null;
            },
            () => {
                if (this.installTask === task) this.installTask = null;
            },
        );
        return task;
    }

    close(): void {
        // 无长连接资源；下载临时文件由 runInstall 的 finally 清理。
    }

    private async runInstall(): Promise<VoiceInstallStatus> {
        const status: VoiceInstallStatus = {
            modelId: SENSEVOICE_MODEL_ID,
            status: 'running',
            progress: 0,
        };
        this.status = status;
        const tempFiles: string[] = [];
        try {
            // DSH 缓存可能在构造之后才就绪；安装前再确认一次。
            if (this.installed()) return doneStatus();
            await mkdir(this.root, { recursive: true });
            const total = this.totalSizeBytes();
            let completed = 0;
            for (const asset of this.assets) {
                const target = this.localPathFor(asset);
                if (isFileWithSize(target, asset.sizeBytes)) {
                    completed += asset.sizeBytes;
                    this.updateProgress(status, completed, total);
                    continue;
                }
                await this.downloadAsset(
                    asset,
                    target,
                    (received) => {
                        this.updateProgress(status, completed + received, total);
                    },
                    tempFiles,
                );
                completed += asset.sizeBytes;
                this.updateProgress(status, completed, total);
            }
            if (!this.isComplete(this.localPaths())) {
                throw new Error('模型文件大小校验失败');
            }
            const result = doneStatus();
            this.status = result;
            this.logger.log(`voice sensevoice model ready at ${this.root}`);
            return result;
        } catch (error) {
            const result: VoiceInstallStatus = {
                modelId: SENSEVOICE_MODEL_ID,
                status: 'error',
                progress: status.progress,
                error: describeError(error),
            };
            this.status = result;
            this.logger.error(`voice sensevoice install failed: ${result.error}`);
            return result;
        } finally {
            await Promise.all(
                tempFiles.map((file) => rm(file, { force: true }).catch(() => undefined)),
            );
        }
    }

    private async downloadAsset(
        asset: SenseVoiceAsset,
        target: string,
        onProgress: (received: number) => void,
        tempFiles: string[],
    ): Promise<void> {
        const partPath = `${target}.part-${process.pid}-${randomUUID()}`;
        tempFiles.push(partPath);
        let response: Response;
        try {
            response = await this.fetchImpl(asset.url, {
                redirect: 'follow',
                headers: { 'user-agent': 'mazi-voice-sensevoice/1' },
            });
        } catch (error) {
            throw new Error(`下载 ${asset.fileName} 失败：${describeError(error)}`);
        }
        if (!response.ok || !response.body) {
            throw new Error(`下载 ${asset.fileName} 失败：HTTP ${response.status}`);
        }
        const hash = createHash('sha256');
        const file = await open(partPath, 'w');
        let received = 0;
        try {
            const reader = response.body.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!value || value.byteLength === 0) continue;
                hash.update(value);
                await file.write(value);
                received += value.byteLength;
                onProgress(received);
            }
        } finally {
            await file.close().catch(() => undefined);
        }
        if (received !== asset.sizeBytes) {
            throw new Error(
                `${asset.fileName} 大小校验失败：期望 ${asset.sizeBytes}，实际 ${received}`,
            );
        }
        const sha256 = hash.digest('hex');
        if (sha256 !== asset.sha256.toLowerCase()) {
            throw new Error(`${asset.fileName} sha256 校验失败`);
        }
        await rename(partPath, target);
    }

    private totalSizeBytes(): number {
        return this.assets.reduce((total, asset) => total + asset.sizeBytes, 0);
    }

    private updateProgress(
        status: VoiceInstallStatus,
        completedBytes: number,
        totalBytes: number,
    ): void {
        status.progress =
            totalBytes > 0 ? Math.min(0.99, Math.max(0, completedBytes / totalBytes)) : 0;
    }

    private isComplete(paths: SenseVoicePaths): boolean {
        return ASSET_KINDS.every((kind) =>
            isFileWithSize(paths[kind], this.assetOf(kind).sizeBytes),
        );
    }

    private assetOf(kind: SenseVoiceAssetKind): SenseVoiceAsset {
        const asset = this.assets.find((candidate) => candidate.kind === kind);
        if (!asset) throw new Error(`SenseVoice 资产清单缺少 ${kind} 文件`);
        return asset;
    }

    private localPaths(): SenseVoicePaths {
        return {
            model: join(this.root, this.assetOf('model').fileName),
            tokens: join(this.root, this.assetOf('tokens').fileName),
            vad: join(this.root, this.assetOf('vad').fileName),
        };
    }

    private localPathFor(asset: SenseVoiceAsset): string {
        return join(this.root, asset.fileName);
    }

    /** DSH 缓存布局（固定文件名，只读）。 */
    private dshCachePaths(): SenseVoicePaths {
        const models = join(this.dshRoot, ...DSH_SENSEVOICE_MODELS_DIR);
        return {
            model: join(models, 'sensevoice-onnx', SENSEVOICE_FILES.model),
            tokens: join(models, 'sensevoice-onnx', SENSEVOICE_FILES.tokens),
            vad: join(models, 'silero', SENSEVOICE_FILES.vad),
        };
    }
}

function doneStatus(): VoiceInstallStatus {
    return { modelId: SENSEVOICE_MODEL_ID, status: 'done', progress: 1 };
}

function isFileWithSize(path: string, sizeBytes: number): boolean {
    try {
        const stats = statSync(path);
        return stats.isFile() && stats.size === sizeBytes;
    } catch {
        return false;
    }
}

function describeError(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}
