import { type ChildProcess, fork } from 'node:child_process';
import Logger from '../common/log.js';
import {
    type VoiceEngineAvailability,
    VoiceEngineError,
    type VoiceEngineHost,
    type VoiceEngineOpenOptions,
    type VoiceEngineSession,
} from './engine.js';
import { VOICE_MODELS, type VoiceModelStore } from './models.js';
import type { ChildCloseRequest, ChildRequest, ChildResponse } from './sherpa-child.js';
import { probeSherpaNode, sherpaChildEnv } from './sherpa-engine.js';

const DEFAULT_OPEN_TIMEOUT_MS = 15_000;
const DEFAULT_PUSH_TIMEOUT_MS = 5_000;
const DEFAULT_END_TIMEOUT_MS = 10_000;
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_BASE_DELAY_MS = 500;
const RESTART_MAX_DELAY_MS = 5_000;

/** 缺省子进程脚本：tsc 后与 sherpa-host.js 同目录（dist/voice/sherpa-child.js）。 */
const DEFAULT_CHILD_SCRIPT = new URL('./sherpa-child.js', import.meta.url);

export interface SherpaHostOptions {
    models: VoiceModelStore;
    logger?: Logger;
    /** 测试可覆盖的子进程脚本路径。 */
    childScript?: URL;
    /** 覆盖单次 IPC 请求超时（默认 open 15s / push 5s / end 10s）。 */
    requestTimeoutMs?: number;
}

interface PendingRequest {
    resolve: (message: ChildResponse) => void;
    reject: (error: VoiceEngineError) => void;
    timer: NodeJS.Timeout;
    sessionId: string;
}

type RequestPayload =
    | {
          type: 'open';
          sessionId: string;
          modelId: string;
          modelDir: string;
          language: string;
          sampleRate: number;
      }
    | { type: 'audio'; sessionId: string; pcm: Uint8Array }
    | { type: 'end'; sessionId: string };

/**
 * 本机 sherpa-onnx ASR 宿主（主进程侧）。
 *
 * - 懒启动 child_process.fork 子进程，原生 addon 崩溃不影响 Nest API；
 * - 按 session 串行收发 IPC（open/audio/end/close → opened/partial/final/error）；
 * - 请求超时：open 15s / chunk 5s / end 10s；超时抛 VoiceEngineError('timeout')；
 * - 子进程异常退出时 reject 所有 pending，指数退避自动重启（最多 3 次），
 *   期间 availability 返回 engine_unavailable，恢复后回到可用。
 *
 * 注意：不记录 PCM / transcript 文本；子进程 stderr 会被转发为错误日志。
 */
export class SherpaHost implements VoiceEngineHost {
    readonly pushTimeoutMs: number;
    readonly endTimeoutMs: number;
    private readonly models: VoiceModelStore;
    private readonly logger: Logger;
    private readonly childScript: URL;
    private readonly openTimeoutMs: number;
    private readonly sessions = new Map<string, SherpaSession>();
    private readonly pending = new Map<number, PendingRequest>();
    private child: ChildProcess | null = null;
    private nextRequestId = 0;
    private restartAttempts = 0;
    private restartTimer: NodeJS.Timeout | null = null;
    private degraded = false;
    private shuttingDown = false;

    constructor(options: SherpaHostOptions) {
        this.models = options.models;
        this.logger = options.logger ?? new Logger('voice-sherpa');
        this.childScript = options.childScript ?? DEFAULT_CHILD_SCRIPT;
        const override = options.requestTimeoutMs;
        this.openTimeoutMs = override ?? DEFAULT_OPEN_TIMEOUT_MS;
        this.pushTimeoutMs = override ?? DEFAULT_PUSH_TIMEOUT_MS;
        this.endTimeoutMs = override ?? DEFAULT_END_TIMEOUT_MS;
    }

    availability(): VoiceEngineAvailability {
        if (this.shuttingDown) {
            return { available: false, reason: 'engine_unavailable' };
        }
        if (this.degraded) {
            return { available: false, reason: 'engine_unavailable' };
        }
        const probe = probeSherpaNode();
        if (!probe.available) {
            return { available: false, reason: probe.reason ?? 'engine_missing' };
        }
        // 任一注册模型已安装即可（兼容旧版已安装的中英混模型）。
        if (!VOICE_MODELS.some((model) => this.models.installed(model.id))) {
            return { available: false, reason: 'model_missing' };
        }
        return { available: true };
    }

    async open(options: VoiceEngineOpenOptions): Promise<VoiceEngineSession> {
        if (!this.models.installed(options.modelId)) {
            throw new VoiceEngineError('model_missing', `语音模型未安装：${options.modelId}`);
        }
        const modelDir =
            options.modelDir && options.modelDir.length > 0
                ? options.modelDir
                : this.models.modelDir(options.modelId);
        await this.request(
            {
                type: 'open',
                sessionId: options.sessionId,
                modelId: options.modelId,
                modelDir,
                language: options.language,
                sampleRate: options.sampleRate,
            },
            this.openTimeoutMs,
        );
        const session = new SherpaSession(this, options.sessionId);
        this.sessions.set(options.sessionId, session);
        // 一次成功加载说明 child 已恢复健康。
        this.restartAttempts = 0;
        this.degraded = false;
        this.clearRestartTimer();
        return session;
    }

    /** 供 SherpaSession 使用：发送一帧音频或结束请求。 */
    requestSession(
        payload:
            | { type: 'audio'; sessionId: string; pcm: Uint8Array }
            | { type: 'end'; sessionId: string },
        timeoutMs: number,
    ): Promise<ChildResponse> {
        return this.request(payload, timeoutMs);
    }

    /** 供 SherpaSession 使用：end 后清理（child 侧已释放 stream）。 */
    forgetSession(sessionId: string): void {
        this.sessions.delete(sessionId);
    }

    /** 供 SherpaSession 使用：通知 child 释放 stream（幂等、fire-and-forget）。 */
    closeSession(sessionId: string): void {
        this.sessions.delete(sessionId);
        const child = this.child;
        if (!child?.connected) return;
        try {
            child.send({ type: 'close', sessionId } satisfies ChildCloseRequest);
        } catch {
            // 子进程已退出，无需清理。
        }
    }

    closeAll(): void {
        this.shuttingDown = true;
        this.clearRestartTimer();
        this.rejectAll(new VoiceEngineError('engine_unavailable', '语音识别进程已关闭', false));
        for (const session of this.sessions.values()) {
            session.noteError(
                new VoiceEngineError('engine_unavailable', '语音识别进程已关闭', false),
            );
        }
        this.sessions.clear();
        const child = this.child;
        this.child = null;
        if (!child) return;
        try {
            child.send({ type: 'shutdown' } satisfies ChildRequest);
        } catch {
            // ignore：进程可能已退出
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

    private request(payload: RequestPayload, timeoutMs: number): Promise<ChildResponse> {
        this.ensureChild();
        const child = this.child;
        if (!child?.connected) {
            throw new VoiceEngineError('engine_unavailable', '语音识别进程不可用', true);
        }
        this.nextRequestId += 1;
        const id = this.nextRequestId;
        return new Promise<ChildResponse>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new VoiceEngineError('timeout', '语音识别超时', true));
            }, timeoutMs);
            timer.unref?.();
            this.pending.set(id, { resolve, reject, timer, sessionId: payload.sessionId });
            try {
                child.send({ ...payload, id }, (error) => {
                    if (!error) return;
                    this.rejectPending(
                        id,
                        new VoiceEngineError(
                            'engine_unavailable',
                            `语音识别进程通信失败：${error.message}`,
                            true,
                        ),
                    );
                });
            } catch (error) {
                this.rejectPending(
                    id,
                    new VoiceEngineError(
                        'engine_unavailable',
                        `语音识别进程通信失败：${describeError(error)}`,
                        true,
                    ),
                );
            }
        });
    }

    private ensureChild(): void {
        if (this.shuttingDown) {
            throw new VoiceEngineError('engine_unavailable', '语音识别进程已关闭', false);
        }
        if (this.child?.connected) return;
        if (this.restartAttempts > MAX_RESTART_ATTEMPTS) {
            throw new VoiceEngineError(
                'engine_unavailable',
                '语音识别进程多次崩溃，已降级为文字输入',
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
        const child = fork(this.childScript, [], {
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            serialization: 'advanced',
            env: sherpaChildEnv(process.env, probe),
            // 子进程只加载编译后的 JS：不继承父进程的调试/loader 参数，
            // 避免 --input-type / --inspect 等参数让 child 启动即失败。
            execArgv: [],
        });
        child.on('message', (message) => this.handleMessage(message));
        child.on('error', (error) => this.handleChildFailure(child, error));
        child.on('exit', (code, signal) => this.handleChildExit(child, code, signal));
        child.stdout?.on('data', (chunk: Buffer) => this.forwardChildLog('debug', chunk));
        child.stderr?.on('data', (chunk: Buffer) => this.forwardChildLog('error', chunk));
        this.child = child;
        // 子进程已重新拉起：恢复 availability（模型是否可用由首次 open 验证）。
        this.degraded = false;
        this.logger.debug(`sherpa child started pid=${child.pid ?? '?'}`);
    }

    private handleMessage(message: unknown): void {
        if (!message || typeof message !== 'object') return;
        const response = message as ChildResponse;
        switch (response.type) {
            case 'opened':
            case 'partial':
            case 'final': {
                const session = this.sessions.get(response.sessionId);
                if (session && response.type !== 'opened') session.noteText(response.text);
                this.resolvePending(response.id, response);
                return;
            }
            case 'error': {
                const error = new VoiceEngineError(
                    response.code,
                    response.message,
                    response.retryable ?? false,
                );
                if (typeof response.id === 'number') this.rejectPending(response.id, error);
                if (response.sessionId) {
                    this.sessions.get(response.sessionId)?.noteError(error);
                }
                this.logger.error(`sherpa error ${response.code}: ${response.message}`);
                return;
            }
            default:
                return;
        }
    }

    private handleChildFailure(child: ChildProcess, error: Error): void {
        if (this.child !== child) return;
        this.child = null;
        this.handleCrash(`语音识别进程错误：${error.message}`);
    }

    private handleChildExit(
        child: ChildProcess,
        code: number | null,
        signal: NodeJS.Signals | null,
    ): void {
        if (this.child !== child) return;
        this.child = null;
        this.handleCrash(`语音识别进程退出（code=${code ?? 'null'}, signal=${signal ?? 'none'}）`);
    }

    private handleCrash(reason: string): void {
        const error = new VoiceEngineError(
            'engine_unavailable',
            `${reason}；语音识别进程已重启，请重试`,
            true,
        );
        this.rejectAll(error);
        for (const session of this.sessions.values()) session.noteError(error);
        this.sessions.clear();
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
                this.logger.error(`sherpa restart failed: ${describeError(error)}`);
            }
        }, delay);
        timer.unref?.();
        this.restartTimer = timer;
    }

    private clearRestartTimer(): void {
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
    }

    private forwardChildLog(level: 'debug' | 'error', chunk: Buffer): void {
        const text = chunk.toString('utf8').trim();
        if (text.length === 0) return;
        for (const line of text.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;
            if (level === 'error') this.logger.error(`sherpa: ${trimmed}`);
            else this.logger.debug(`sherpa: ${trimmed}`);
        }
    }

    private resolvePending(id: number, response: ChildResponse): void {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.resolve(response);
    }

    private rejectPending(id: number, error: VoiceEngineError): void {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
    }

    private rejectAll(error: VoiceEngineError): void {
        for (const [id, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(error);
            this.pending.delete(id);
        }
    }
}

/** 一个 utterance 的流式识别会话（IPC 客户端侧）。 */
export class SherpaSession implements VoiceEngineSession {
    private closed = false;
    private error: VoiceEngineError | undefined;
    private latestText = '';

    constructor(
        private readonly host: SherpaHost,
        readonly sessionId: string,
    ) {}

    noteText(text: string): void {
        this.latestText = text;
    }

    noteError(error: VoiceEngineError): void {
        this.error = error;
    }

    async push(pcm: Uint8Array): Promise<{ partial?: string }> {
        if (this.error) throw this.error;
        if (this.closed) throw new VoiceEngineError('asr_failed', '语音识别会话已关闭');
        if (pcm.byteLength === 0) return {};
        const response = await this.host.requestSession(
            { type: 'audio', sessionId: this.sessionId, pcm },
            this.host.pushTimeoutMs,
        );
        if (response.type === 'error') {
            throw new VoiceEngineError(
                response.code,
                response.message,
                response.retryable ?? false,
            );
        }
        const text = response.type === 'partial' ? response.text : '';
        if (text.length > 0) this.latestText = text;
        return text.length > 0 ? { partial: text } : {};
    }

    async end(): Promise<{ text: string }> {
        if (this.closed) return { text: this.latestText };
        if (this.error) {
            this.close();
            throw this.error;
        }
        try {
            const response = await this.host.requestSession(
                { type: 'end', sessionId: this.sessionId },
                this.host.endTimeoutMs,
            );
            if (response.type === 'error') {
                throw new VoiceEngineError(
                    response.code,
                    response.message,
                    response.retryable ?? false,
                );
            }
            const text = response.type === 'final' ? response.text : this.latestText;
            this.latestText = text;
            return { text };
        } catch (error) {
            // end 失败时 child 侧 stream 可能仍存在，主动释放。
            this.host.closeSession(this.sessionId);
            throw error;
        } finally {
            this.closed = true;
            this.host.forgetSession(this.sessionId);
        }
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.host.closeSession(this.sessionId);
    }
}

function describeError(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}
