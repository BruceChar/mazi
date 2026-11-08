import { type ChildProcess, fork } from 'node:child_process';
import Logger from '../../common/log.js';
import { VoiceEngineError } from '../engine.js';
import { probeSherpaNode, sherpaChildEnv, toPcmBytes } from '../sherpa-engine.js';
import {
    SENSEVOICE_MODEL_PATH_ENV,
    SENSEVOICE_TOKENS_PATH_ENV,
    SENSEVOICE_VAD_PATH_ENV,
} from './assets.js';
import type { SenseVoiceChildRequest, SenseVoiceChildResponse } from './child.js';
import type {
    SenseVoiceAvailability,
    SenseVoiceHost as SenseVoiceHostContract,
    SenseVoiceModelStore,
    SenseVoiceTranscribeInput,
    SenseVoiceTranscribeResult,
} from './types.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_BASE_DELAY_MS = 500;
const RESTART_MAX_DELAY_MS = 5_000;

/** 缺省子进程脚本：tsc 后与 host.js 同目录（dist/voice/sensevoice/child.js）。 */
const DEFAULT_CHILD_SCRIPT = new URL('./child.js', import.meta.url);

export interface SenseVoiceHostOptions {
    store: SenseVoiceModelStore;
    logger?: Logger;
    /** 测试可覆盖的子进程脚本路径。 */
    childScript?: URL;
    /** 覆盖单次整段转写超时（默认 120s，包含首次加载模型时间）。 */
    requestTimeoutMs?: number;
}

interface PendingTranscribe {
    resolve: (result: SenseVoiceTranscribeResult) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

/**
 * 整段离线转写宿主（主进程侧）。
 *
 * - 懒启动 child_process.fork 子进程（原生 addon 崩溃不影响 Nest API）；
 * - 所有 transcribe 按调用顺序串行排队（子进程内只持有一份 VAD/Recognizer）；
 * - 单次请求超时默认 120s；子进程异常退出时 reject pending，指数退避重启（最多 3 次），
 *   期间 availability 返回 engine_unavailable；
 * - 不记录音频 / 识别文本。
 */
export class SenseVoiceHost implements SenseVoiceHostContract {
    private readonly store: SenseVoiceModelStore;
    private readonly logger: Logger;
    private readonly childScript: URL;
    private readonly requestTimeoutMs: number;
    private readonly pending = new Map<number, PendingTranscribe>();
    private child: ChildProcess | null = null;
    private nextRequestId = 0;
    private restartAttempts = 0;
    private restartTimer: NodeJS.Timeout | null = null;
    private degraded = false;
    private shuttingDown = false;
    private tail: Promise<unknown> = Promise.resolve();

    constructor(options: SenseVoiceHostOptions) {
        this.store = options.store;
        this.logger = options.logger ?? new Logger('voice-sensevoice');
        this.childScript = options.childScript ?? DEFAULT_CHILD_SCRIPT;
        this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    }

    availability(): SenseVoiceAvailability {
        if (this.shuttingDown) return { available: false, reason: 'engine_unavailable' };
        if (this.degraded) return { available: false, reason: 'engine_unavailable' };
        const probe = probeSherpaNode();
        if (!probe.available) return { available: false, reason: probe.reason ?? 'engine_missing' };
        if (!this.store.installed()) return { available: false, reason: 'model_missing' };
        return { available: true };
    }

    transcribe(input: SenseVoiceTranscribeInput): Promise<SenseVoiceTranscribeResult> {
        // 串行化：前一次失败不阻塞后续请求。
        const run = this.tail.then(
            () => this.performTranscribe(input),
            () => this.performTranscribe(input),
        );
        this.tail = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }

    closeAll(): void {
        this.shuttingDown = true;
        this.clearRestartTimer();
        this.rejectAll(new VoiceEngineError('engine_unavailable', '语音转写进程已关闭', false));
        const child = this.child;
        this.child = null;
        if (!child) return;
        try {
            child.send({ type: 'shutdown' } satisfies SenseVoiceChildRequest);
        } catch {
            // 子进程可能已退出。
        }
        const timer = setTimeout(() => {
            try {
                child.kill();
            } catch {
                // ignore
            }
        }, 1000);
        timer.unref?.();
    }

    private async performTranscribe(
        input: SenseVoiceTranscribeInput,
    ): Promise<SenseVoiceTranscribeResult> {
        const availability = this.availability();
        if (!availability.available) {
            const modelMissing = availability.reason === 'model_missing';
            throw new VoiceEngineError(
                modelMissing ? 'model_missing' : 'engine_unavailable',
                modelMissing ? '语音模型尚未安装完成' : '语音转写引擎不可用',
                modelMissing,
            );
        }
        const pcm = toPcmBytes(input.pcm);
        if (pcm.byteLength === 0) {
            throw new VoiceEngineError('bad_request', '音频为空', false);
        }
        const sampleRate = Number(input.sampleRate) || 16000;
        const child = this.ensureChild();
        this.nextRequestId += 1;
        const id = this.nextRequestId;
        return new Promise<SenseVoiceTranscribeResult>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new VoiceEngineError('timeout', '语音转写超时', true));
            }, this.requestTimeoutMs);
            timer.unref?.();
            this.pending.set(id, { resolve, reject, timer });
            const message: SenseVoiceChildRequest = {
                type: 'transcribe',
                id,
                pcm,
                sampleRate,
                language: input.language.length > 0 ? input.language : 'auto',
            };
            try {
                child.send(message, (error) => {
                    if (!error) return;
                    this.rejectPending(
                        id,
                        new VoiceEngineError(
                            'engine_unavailable',
                            `语音转写进程通信失败：${error.message}`,
                            true,
                        ),
                    );
                });
            } catch (error) {
                this.rejectPending(
                    id,
                    new VoiceEngineError(
                        'engine_unavailable',
                        `语音转写进程通信失败：${describeError(error)}`,
                        true,
                    ),
                );
            }
        });
    }

    private ensureChild(): ChildProcess {
        if (this.shuttingDown) {
            throw new VoiceEngineError('engine_unavailable', '语音转写进程已关闭', false);
        }
        if (this.child?.connected) return this.child;
        if (this.restartAttempts > MAX_RESTART_ATTEMPTS) {
            throw new VoiceEngineError(
                'engine_unavailable',
                '语音转写进程多次崩溃，已降级为文字输入',
                true,
            );
        }
        const probe = probeSherpaNode();
        if (!probe.available) {
            throw new VoiceEngineError(
                'engine_unavailable',
                'sherpa-onnx-node 未安装或不可用',
                false,
            );
        }
        const paths = this.store.paths();
        if (!paths) {
            throw new VoiceEngineError('model_missing', '语音模型尚未安装完成', true);
        }
        const child = fork(this.childScript, [], {
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            serialization: 'advanced',
            env: {
                ...sherpaChildEnv(process.env, probe),
                [SENSEVOICE_MODEL_PATH_ENV]: paths.model,
                [SENSEVOICE_TOKENS_PATH_ENV]: paths.tokens,
                [SENSEVOICE_VAD_PATH_ENV]: paths.vad,
            },
            // 子进程只加载编译后的 JS：不继承父进程的调试/loader 参数。
            execArgv: [],
        });
        child.on('message', (message) => this.handleMessage(message));
        child.on('error', (error) => this.handleChildFailure(child, error));
        child.on('exit', (code, signal) => this.handleChildExit(child, code, signal));
        child.stdout?.on('data', (chunk: Buffer) => this.forwardChildLog('debug', chunk));
        child.stderr?.on('data', (chunk: Buffer) => this.forwardChildLog('error', chunk));
        this.child = child;
        this.degraded = false;
        this.logger.debug(`sensevoice child started pid=${child.pid ?? '?'}`);
        return child;
    }

    private handleMessage(message: unknown): void {
        if (!message || typeof message !== 'object') return;
        const response = message as SenseVoiceChildResponse;
        switch (response.type) {
            case 'ready':
                this.logger.debug('sensevoice child ready');
                return;
            case 'result': {
                this.markHealthy();
                this.resolvePending(response.id, {
                    text: typeof response.text === 'string' ? response.text : '',
                    inferenceMs: Number.isFinite(response.inferenceMs) ? response.inferenceMs : 0,
                });
                return;
            }
            case 'error': {
                const error = new VoiceEngineError(
                    response.code ?? 'asr_failed',
                    response.message,
                    response.retryable ?? false,
                );
                if (typeof response.id === 'number') this.rejectPending(response.id, error);
                else this.rejectAll(error);
                this.logger.error(`sensevoice error ${error.code}: ${error.message}`);
                return;
            }
            default:
                return;
        }
    }

    private handleChildFailure(child: ChildProcess, error: Error): void {
        if (this.child !== child) return;
        this.child = null;
        this.handleCrash(`语音转写进程错误：${error.message}`);
    }

    private handleChildExit(
        child: ChildProcess,
        code: number | null,
        signal: NodeJS.Signals | null,
    ): void {
        if (this.child !== child) return;
        this.child = null;
        this.handleCrash(`语音转写进程退出（code=${code ?? 'null'}, signal=${signal ?? 'none'}）`);
    }

    private handleCrash(reason: string): void {
        const error = new VoiceEngineError(
            'engine_unavailable',
            `${reason}；语音转写进程已重启，请重试`,
            true,
        );
        this.rejectAll(error);
        this.restartAttempts += 1;
        this.degraded = true;
        this.logger.error(reason);
        if (!this.shuttingDown && this.restartAttempts <= MAX_RESTART_ATTEMPTS) {
            this.scheduleRestart();
        }
    }

    private scheduleRestart(): void {
        if (this.restartTimer || this.shuttingDown) return;
        const delay = Math.min(
            RESTART_BASE_DELAY_MS * 2 ** (this.restartAttempts - 1),
            RESTART_MAX_DELAY_MS,
        );
        const timer = setTimeout(() => {
            this.restartTimer = null;
            if (this.shuttingDown) return;
            try {
                this.ensureChild();
            } catch (error) {
                this.logger.error(`sensevoice restart failed: ${describeError(error)}`);
            }
        }, delay);
        timer.unref?.();
        this.restartTimer = timer;
    }

    private markHealthy(): void {
        this.degraded = false;
        this.restartAttempts = 0;
        this.clearRestartTimer();
    }

    private clearRestartTimer(): void {
        if (!this.restartTimer) return;
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
    }

    private forwardChildLog(level: 'debug' | 'error', chunk: Buffer): void {
        const text = chunk.toString('utf8').trim();
        if (text.length === 0) return;
        for (const line of text.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;
            if (level === 'error') this.logger.error(`sensevoice: ${trimmed}`);
            else this.logger.debug(`sensevoice: ${trimmed}`);
        }
    }

    private resolvePending(id: number, result: SenseVoiceTranscribeResult): void {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.resolve(result);
    }

    private rejectPending(id: number, error: Error): void {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
    }

    private rejectAll(error: Error): void {
        for (const [id, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(error);
            this.pending.delete(id);
        }
    }
}

function describeError(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}
