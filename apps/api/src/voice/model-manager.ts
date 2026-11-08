import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { VoiceApiError, VoiceInstallStatus, VoiceModelInfo } from '@mazi/libs';
import Logger from '../common/log.js';
import {
    VOICE_MODELS,
    type VoiceModelDefinition,
    type VoiceModelStore,
    voiceModelInfo,
} from './models.js';

/** 本机语音模型根目录环境变量（覆盖 MAZI_HOME/voice/models）。 */
export const VOICE_MODEL_DIR_ENV = 'MAZI_VOICE_MODEL_DIR';

/** 模型清单文件名：与 models 目录同级（$MAZI_HOME/voice/models.json）。 */
const MANIFEST_FILE_NAME = 'models.json';
const MANIFEST_VERSION = 1;
/** 安装记录（models.json），用于记录 sha256 / 安装时间 / 许可。 */
export interface VoiceModelInstallRecord {
    id: string;
    /** tar.bz2 归档的 sha256（小写十六进制）。 */
    sha256: string;
    sizeBytes: number;
    license: string;
    /** ISO 时间戳。 */
    installedAt: string;
    sourceUrl: string;
}

export interface VoiceModelsManifest {
    version: typeof MANIFEST_VERSION;
    models: Record<string, VoiceModelInstallRecord>;
}

export type VoiceDownloadState = 'running' | 'done' | 'error';

/** 下载 job 快照（与 models.ts VoiceModelStore.downloadStatus 的公共形状兼容）。 */
export interface VoiceDownloadStatus {
    jobId: string;
    modelId: string;
    status: VoiceDownloadState;
    /** 0-1；下载完成且安装成功为 1。 */
    progress: number;
    bytesReceived: number;
    bytesTotal: number;
    error?: string;
    startedAt: number;
    updatedAt: number;
}

/** ModelManager 抛出的错误；code 与语音 API 错误码一致，便于路由层映射。 */
export class VoiceModelError extends Error {
    readonly code: VoiceApiError['code'];
    readonly retryable: boolean;

    constructor(code: VoiceApiError['code'], message: string, retryable = false) {
        super(message);
        this.name = 'VoiceModelError';
        this.code = code;
        this.retryable = retryable;
    }
}

export interface ModelManagerOptions {
    /** 模型根目录；缺省 MAZI_VOICE_MODEL_DIR 或 $MAZI_HOME/voice/models。 */
    root?: string;
    logger?: Logger;
    /** 测试注入：替换模型注册表。 */
    models?: readonly VoiceModelDefinition[];
    /** 测试注入：替换 fetch。 */
    fetchImpl?: typeof fetch;
    /** 解压/列目录使用的 tar 可执行文件，默认 'tar'。 */
    tarCommand?: string;
}

interface DownloadJob {
    jobId: string;
    modelId: string;
    status: VoiceDownloadState;
    progress: number;
    bytesReceived: number;
    bytesTotal: number;
    error?: string;
    startedAt: number;
    updatedAt: number;
    controller?: AbortController;
    /** 删除模型时取消进行中的下载。 */
    canceled?: boolean;
    finished: Promise<void>;
    resolveFinished: () => void;
}

/**
 * 本机语音模型管理：下载 tar.bz2 → 校验 → 安全解压 → 原子安装。
 *
 * 目录约定（设计文档 §6.4 / §9.2）：
 * - 模型根目录：MAZI_VOICE_MODEL_DIR 或 $MAZI_HOME/voice/models；
 * - 模型目录：<root>/<id>/，安装完成前使用 <root>/.download-<jobId> 临时目录；
 * - 清单：<root 同级>/models.json（记录 sha256 / 安装时间 / 许可）。
 *
 * 安全约束：模型 id 必须在注册表内；归档条目拒绝绝对路径与 '..'；解压后拒绝
 * 逃逸出临时目录的符号链接；删除时只允许模型根目录内的路径。
 */
export class ModelManager implements VoiceModelStore {
    private readonly root: string;
    private readonly manifestFile: string;
    private readonly models: readonly VoiceModelDefinition[];
    private readonly logger: Logger;
    private readonly fetchImpl: typeof fetch;
    private readonly tarCommand: string;
    private readonly jobs = new Map<string, DownloadJob>();
    private readonly queue: string[] = [];
    private activeJobId: string | null = null;
    /** 服务启动时自动安装默认模型的任务与最近一次结果。 */
    private autoInstallJobId: string | null = null;
    private autoInstallSnapshot: VoiceInstallStatus | null = null;
    private autoInstallPromise: Promise<VoiceInstallStatus | null> | null = null;

    constructor(options: ModelManagerOptions = {}) {
        this.root = resolve(options.root ?? defaultModelRoot());
        this.manifestFile = join(dirname(this.root), MANIFEST_FILE_NAME);
        this.models = options.models ?? VOICE_MODELS;
        this.logger = options.logger ?? new Logger('voice-models');
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
        this.tarCommand = options.tarCommand ?? 'tar';
    }

    /** 模型根目录（绝对路径）。 */
    rootDir(): string {
        return this.root;
    }

    list(): VoiceModelInfo[] {
        return this.models.map((model) => voiceModelInfo(model, this.installed(model.id)));
    }

    installed(id: string): boolean {
        const model = this.find(id);
        if (!model) return false;
        const dir = this.dirFor(model);
        const files = listFileNames(dir);
        return model.files
            .filter((spec) => spec.required)
            .every((spec) => files.some((name) => matchFilePattern(spec.pattern, name)));
    }

    modelDir(id: string): string {
        const model = this.find(id);
        if (!model) {
            throw new VoiceModelError('not_found', `未知语音模型：${id}`);
        }
        return this.dirFor(model);
    }

    startDownload(id: string): { jobId: string } {
        const model = this.find(id);
        if (!model) {
            throw new VoiceModelError('not_found', `未知语音模型：${id}`);
        }
        this.pruneJobs();
        const running = [...this.jobs.values()].find(
            (job) => job.modelId === id && job.status === 'running',
        );
        if (running) return { jobId: running.jobId };
        const job = this.createJob(model);
        this.jobs.set(job.jobId, job);
        if (this.installed(id)) {
            job.progress = 1;
            job.bytesReceived = model.sizeBytes;
            job.bytesTotal = model.sizeBytes;
            this.finishJob(job);
            return { jobId: job.jobId };
        }
        job.progress = 0;
        job.bytesTotal = model.sizeBytes;
        this.queue.push(job.jobId);
        this.pump();
        return { jobId: job.jobId };
    }

    downloadStatus(jobId: string): VoiceDownloadStatus | undefined {
        const job = this.jobs.get(jobId);
        return job ? this.snapshot(job) : undefined;
    }

    /** 服务启动时自动安装默认模型的进度（无需用户选择）。 */
    autoInstallStatus(): VoiceInstallStatus | undefined {
        const defaultModel = this.models.find((item) => item.recommended) ?? this.models[0];
        if (defaultModel && this.installed(defaultModel.id)) {
            this.autoInstallSnapshot = {
                modelId: defaultModel.id,
                status: 'done',
                progress: 1,
            };
            return this.autoInstallSnapshot;
        }
        if (this.autoInstallJobId) {
            const job = this.jobs.get(this.autoInstallJobId);
            if (job) {
                return {
                    modelId: job.modelId,
                    status:
                        job.status === 'running'
                            ? 'running'
                            : job.status === 'done'
                              ? 'done'
                              : 'error',
                    progress: job.progress,
                    ...(job.error ? { error: job.error } : {}),
                };
            }
        }
        return this.autoInstallSnapshot ?? undefined;
    }

    /**
     * 确保默认模型已安装：已安装直接返回 done；否则启动下载并等待完成。
     * 幂等：并发的启动安装请求复用同一个 Promise；失败由调用方（main）重试。
     */
    async ensureDefaultModel(): Promise<VoiceInstallStatus | null> {
        const model = this.models.find((item) => item.recommended) ?? this.models[0];
        if (!model) return null;
        if (this.installed(model.id)) {
            this.autoInstallSnapshot = { modelId: model.id, status: 'done', progress: 1 };
            return this.autoInstallSnapshot;
        }
        if (this.autoInstallPromise) return this.autoInstallPromise;
        this.autoInstallPromise = this.runAutoInstall(model).finally(() => {
            this.autoInstallPromise = null;
        });
        return this.autoInstallPromise;
    }

    private async runAutoInstall(model: VoiceModelDefinition): Promise<VoiceInstallStatus> {
        const { jobId } = this.startDownload(model.id);
        this.autoInstallJobId = jobId;
        const status = await this.waitForDownload(jobId);
        const result: VoiceInstallStatus =
            status.status === 'done'
                ? { modelId: model.id, status: 'done', progress: 1 }
                : {
                      modelId: model.id,
                      status: 'error',
                      progress: status.progress,
                      ...(status.error ? { error: status.error } : {}),
                  };
        this.autoInstallSnapshot = result;
        return result;
    }

    /** 等待下载 job 结束（成功/失败）后返回最终状态；供 warmup 与测试使用。 */
    async waitForDownload(jobId: string): Promise<VoiceDownloadStatus> {
        const job = this.jobs.get(jobId);
        if (!job) {
            throw new VoiceModelError('not_found', `下载任务不存在：${jobId}`);
        }
        await job.finished;
        return this.snapshot(job);
    }

    /**
     * 删除已安装模型（幂等；未知/不安全的 id 直接 no-op，不触碰任何路径）。
     * 返回 Promise<void> 以满足 VoiceModelStore.remove?（调用方可不 await），
     * 内部吞掉错误并记录日志，避免 unhandled rejection。
     */
    async remove(id: string): Promise<void> {
        const model = this.find(id);
        if (!model) return;
        let target: string;
        try {
            target = this.dirFor(model);
        } catch {
            return;
        }
        try {
            this.cancelDownloads(id);
            await rm(target, { recursive: true, force: true });
            await this.deleteManifestRecord(id);
            this.logger.log(`voice model removed ${id}`);
        } catch (error) {
            this.logger.error(`voice model remove failed ${id}: ${describeError(error)}`);
        }
    }

    private find(id: string): VoiceModelDefinition | undefined {
        return this.models.find((model) => model.id === id);
    }

    /** 注册表中的模型目录；始终校验仍在模型根目录内。 */
    private dirFor(model: VoiceModelDefinition): string {
        if (isUnsafeSegment(model.id)) {
            throw new VoiceModelError('bad_request', `非法语音模型 id：${model.id}`);
        }
        const target = resolve(this.root, model.id);
        const rel = relative(this.root, target);
        if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) {
            throw new VoiceModelError('bad_request', '语音模型路径越界');
        }
        return target;
    }

    private createJob(model: VoiceModelDefinition): DownloadJob {
        let resolveFinished!: () => void;
        const finished = new Promise<void>((resolvePromise) => {
            resolveFinished = resolvePromise;
        });
        const now = Date.now();
        return {
            jobId: randomUUID(),
            modelId: model.id,
            status: 'running',
            progress: 0,
            bytesReceived: 0,
            bytesTotal: model.sizeBytes,
            startedAt: now,
            updatedAt: now,
            finished,
            resolveFinished,
        };
    }

    private snapshot(job: DownloadJob): VoiceDownloadStatus {
        return {
            jobId: job.jobId,
            modelId: job.modelId,
            status: job.status,
            progress: job.progress,
            bytesReceived: job.bytesReceived,
            bytesTotal: job.bytesTotal,
            ...(job.error ? { error: job.error } : {}),
            startedAt: job.startedAt,
            updatedAt: job.updatedAt,
        };
    }

    private finishJob(job: DownloadJob): void {
        job.updatedAt = Date.now();
        job.controller = undefined;
        job.resolveFinished();
    }

    /** 取消某模型的排队/进行中下载（删除模型时调用）。 */
    private cancelDownloads(id: string): void {
        const queue = this.queue.filter((jobId) => this.jobs.get(jobId)?.modelId !== id);
        this.queue.splice(0, this.queue.length, ...queue);
        for (const job of this.jobs.values()) {
            if (job.modelId !== id || job.status !== 'running') continue;
            job.canceled = true;
            if (this.activeJobId === job.jobId) {
                job.controller?.abort();
            } else {
                job.status = 'error';
                job.error = '模型下载已取消（模型被删除）';
                this.finishJob(job);
            }
        }
    }

    private pruneJobs(): void {
        const cutoff = Date.now() - 60 * 60 * 1000;
        for (const [jobId, job] of this.jobs) {
            if (job.status !== 'running' && job.updatedAt < cutoff) this.jobs.delete(jobId);
        }
        // 兜底上限，避免长时间运行的内存增长。
        const finished = [...this.jobs.values()].filter((job) => job.status !== 'running');
        for (const job of finished.slice(0, Math.max(0, finished.length - 50))) {
            this.jobs.delete(job.jobId);
        }
    }

    private pump(): void {
        if (this.activeJobId) return;
        while (this.queue.length > 0) {
            const jobId = this.queue.shift();
            if (!jobId) continue;
            const job = this.jobs.get(jobId);
            if (job?.status !== 'running') continue;
            this.activeJobId = jobId;
            void this.runDownload(job).finally(() => {
                this.activeJobId = null;
                this.pump();
            });
            return;
        }
    }

    private async runDownload(job: DownloadJob): Promise<void> {
        try {
            await this.performDownload(job);
            job.status = 'done';
            job.progress = 1;
            this.logger.log(`voice model installed ${job.modelId}`);
        } catch (error) {
            job.status = 'error';
            job.error = describeError(error);
            this.logger.error(`voice model download failed ${job.modelId}: ${job.error}`);
        } finally {
            this.finishJob(job);
        }
    }

    private async performDownload(job: DownloadJob): Promise<void> {
        const model = this.find(job.modelId);
        if (!model) throw new VoiceModelError('not_found', `未知语音模型：${job.modelId}`);
        const workDir = join(this.root, `.download-${job.jobId}`);
        const archivePath = join(workDir, 'archive.tar.bz2');
        const extractDir = join(workDir, 'extract');
        await mkdir(workDir, { recursive: true });
        try {
            if (job.canceled) throw new VoiceModelError('internal_error', '模型下载已取消');
            const sha256 = await this.downloadArchive(model, archivePath, job);
            if (job.canceled) throw new VoiceModelError('internal_error', '模型下载已取消');
            job.progress = 0.96;
            job.updatedAt = Date.now();
            await this.extractArchive(archivePath, extractDir);
            job.progress = 0.98;
            job.updatedAt = Date.now();
            const modelRoot = await this.findExtractedModelRoot(model, extractDir);
            if (job.canceled) throw new VoiceModelError('internal_error', '模型下载已取消');
            await this.installModel(model, modelRoot);
            await this.recordInstall(model, sha256);
        } finally {
            await rm(workDir, { recursive: true, force: true }).catch((error: unknown) => {
                this.logger.warn(`voice model cleanup failed: ${describeError(error)}`);
            });
        }
    }

    private async downloadArchive(
        model: VoiceModelDefinition,
        archivePath: string,
        job: DownloadJob,
    ): Promise<string> {
        if (job.canceled) throw new VoiceModelError('internal_error', '模型下载已取消');
        const controller = new AbortController();
        job.controller = controller;
        let response: Response;
        try {
            response = await this.fetchImpl(model.url, {
                redirect: 'follow',
                signal: controller.signal,
                headers: { 'user-agent': 'mazi-voice-model-manager/1' },
            });
        } catch (error) {
            if (controller.signal.aborted) {
                throw new VoiceModelError('engine_unavailable', '模型下载已取消', true);
            }
            throw new VoiceModelError(
                'engine_unavailable',
                `模型下载失败：${describeError(error)}`,
                true,
            );
        }
        if (!response.ok || !response.body) {
            throw new VoiceModelError(
                'engine_unavailable',
                `模型下载失败：HTTP ${response.status}`,
                true,
            );
        }
        const contentLength = Number(response.headers.get('content-length'));
        const total =
            Number.isFinite(contentLength) && contentLength > 0 ? contentLength : model.sizeBytes;
        job.bytesTotal = total;
        job.bytesReceived = 0;
        // 先写 .part，校验/下载完成后再改名，避免把半成品当成完整归档。
        const partPath = `${archivePath}.part`;
        const hash = createHash('sha256');
        const file = await open(partPath, 'w');
        const reader = response.body.getReader();
        try {
            for (;;) {
                if (controller.signal.aborted || job.canceled) {
                    throw new VoiceModelError('internal_error', '模型下载已取消');
                }
                const { done, value } = await reader.read();
                if (done) break;
                if (!value || value.byteLength === 0) continue;
                hash.update(value);
                await file.write(value);
                job.bytesReceived += value.byteLength;
                job.progress = total > 0 ? Math.min(0.95, (job.bytesReceived / total) * 0.95) : 0;
                job.updatedAt = Date.now();
            }
        } finally {
            await file.close().catch(() => undefined);
        }
        const sha256 = hash.digest('hex');
        const expected = (model as { sha256?: unknown }).sha256;
        if (typeof expected === 'string' && expected.toLowerCase() !== sha256) {
            throw new VoiceModelError('internal_error', '模型归档 sha256 校验失败');
        }
        await rename(partPath, archivePath);
        return sha256;
    }

    private async extractArchive(archivePath: string, extractDir: string): Promise<void> {
        const listing = await this.runTar(['-tjf', archivePath]);
        for (const rawLine of listing.split(/\r?\n/)) {
            const name = rawLine.trim();
            if (name.length === 0) continue;
            if (!isSafeArchivePath(name)) {
                throw new VoiceModelError('internal_error', `模型归档包含不安全路径：${name}`);
            }
        }
        await mkdir(extractDir, { recursive: true });
        await this.runTar(['-xjf', archivePath, '-C', extractDir]);
        await assertNoEscapingLinks(extractDir);
    }

    private runTar(args: string[]): Promise<string> {
        return new Promise((resolvePromise, rejectPromise) => {
            execFile(
                this.tarCommand,
                args,
                { maxBuffer: 256 * 1024 * 1024, windowsHide: true },
                (error, stdout, stderr) => {
                    if (error) {
                        const detail = stderr.trim() || error.message;
                        rejectPromise(
                            new VoiceModelError('internal_error', `解压模型归档失败：${detail}`),
                        );
                        return;
                    }
                    resolvePromise(stdout);
                },
            );
        });
    }

    private async findExtractedModelRoot(
        model: VoiceModelDefinition,
        extractDir: string,
    ): Promise<string> {
        const required = model.files.filter((spec) => spec.required);
        const candidates: string[] = [];
        const walk = async (dir: string): Promise<void> => {
            candidates.push(dir);
            const entries = await readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) await walk(join(dir, entry.name));
            }
        };
        await walk(extractDir);
        candidates.sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
        for (const dir of candidates) {
            const entries = await readdir(dir, { withFileTypes: true });
            const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
            if (
                required.length > 0 &&
                required.every((spec) => files.some((name) => matchFilePattern(spec.pattern, name)))
            ) {
                return dir;
            }
            if (required.length === 0 && files.length > 0) return dir;
        }
        const missing = required.map((spec) => spec.pattern).join(', ');
        throw new VoiceModelError('internal_error', `模型归档缺少必需文件：${missing || '(无)'}`);
    }

    private async installModel(model: VoiceModelDefinition, sourceDir: string): Promise<void> {
        const target = this.dirFor(model);
        await mkdir(this.root, { recursive: true });
        // 清理历史半成品（rename 前保证目标是空路径）。
        await rm(target, { recursive: true, force: true });
        await rename(sourceDir, target);
    }

    private async recordInstall(model: VoiceModelDefinition, sha256: string): Promise<void> {
        const manifest = this.readManifest();
        manifest.models[model.id] = {
            id: model.id,
            sha256,
            sizeBytes: model.sizeBytes,
            license: model.license,
            installedAt: new Date().toISOString(),
            sourceUrl: model.url,
        };
        await this.writeManifest(manifest);
    }

    private async deleteManifestRecord(id: string): Promise<void> {
        const manifest = this.readManifest();
        if (!(id in manifest.models)) return;
        delete manifest.models[id];
        await this.writeManifest(manifest);
    }

    private readManifest(): VoiceModelsManifest {
        try {
            const raw = readFileSync(this.manifestFile, 'utf8');
            const parsed = JSON.parse(raw) as Partial<VoiceModelsManifest>;
            const models = parsed.models && typeof parsed.models === 'object' ? parsed.models : {};
            return { version: MANIFEST_VERSION, models };
        } catch {
            return { version: MANIFEST_VERSION, models: {} };
        }
    }

    private async writeManifest(manifest: VoiceModelsManifest): Promise<void> {
        await mkdir(dirname(this.manifestFile), { recursive: true });
        const tmp = `${this.manifestFile}.tmp-${process.pid}-${randomUUID()}`;
        await writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        await rename(tmp, this.manifestFile);
    }
}

/** 模型根目录：MAZI_VOICE_MODEL_DIR > $MAZI_HOME/voice/models（支持 ~ 展开）。 */
export function defaultModelRoot(env: NodeJS.ProcessEnv = process.env): string {
    const override = env[VOICE_MODEL_DIR_ENV]?.trim();
    if (override) return resolve(expandHome(override));
    const home = env.MAZI_HOME?.trim();
    return resolve(join(expandHome(home && home.length > 0 ? home : '~/.mazi'), 'voice', 'models'));
}

/** 展开前导 ~（与 @mazi/runtime maziHome 的约定一致）。 */
function expandHome(value: string): string {
    if (value === '~') return homedir();
    if (value.startsWith('~/')) return join(homedir(), value.slice(2));
    return value;
}

/** 归档条目是否安全：非绝对路径、无盘符、无 '..' 段、无 NUL。 */
export function isSafeArchivePath(name: string): boolean {
    if (name.length === 0 || name.includes('\0')) return false;
    const normalized = name.replace(/\\/g, '/');
    if (normalized.startsWith('/')) return false;
    if (/^[A-Za-z]:/.test(normalized)) return false;
    return !normalized.split('/').includes('..');
}

/** 简单的 glob 匹配（仅支持 '*'，其余字符按字面量）。 */
export function matchFilePattern(pattern: string, filename: string): boolean {
    const escaped = pattern.replace(/[.+^$(){}[\]|\\]/g, '\\$&');
    const regexp = new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    return regexp.test(filename);
}

function listFileNames(dir: string): string[] {
    try {
        return readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => entry.name);
    } catch {
        return [];
    }
}

function isUnsafeSegment(id: string): boolean {
    return (
        id.length === 0 ||
        id.includes('/') ||
        id.includes('\\') ||
        id === '.' ||
        id === '..' ||
        isAbsolute(id)
    );
}

function depth(path: string): number {
    return path.split(/[\\/]/).filter(Boolean).length;
}

/** 解压后校验符号链接不逃逸临时目录；也拒绝设备/管道等特殊条目。 */
async function assertNoEscapingLinks(root: string): Promise<void> {
    const rootReal = await realpath(root);
    const walk = async (dir: string): Promise<void> => {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const full = join(dir, entry.name);
            if (entry.isSymbolicLink()) {
                let target: string;
                try {
                    target = await realpath(full);
                } catch {
                    throw new VoiceModelError(
                        'internal_error',
                        `模型归档包含无效符号链接：${entry.name}`,
                    );
                }
                const rel = relative(rootReal, target);
                if (rel.startsWith('..') || isAbsolute(rel)) {
                    throw new VoiceModelError(
                        'internal_error',
                        `模型归档的符号链接指向模型目录之外：${entry.name}`,
                    );
                }
            } else if (entry.isDirectory()) {
                await walk(full);
            } else if (!entry.isFile()) {
                throw new VoiceModelError(
                    'internal_error',
                    `模型归档包含不支持的条目：${entry.name}`,
                );
            }
        }
    };
    await walk(root);
}

function describeError(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}
