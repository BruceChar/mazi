/**
 * 语音输入控制器（本机离线识别 only，DSH 方式：整段录音 → 一次性转写）。
 *
 * 交互（按用户要求收敛）：
 * - 点击麦克风开始录音；再次点击停止；
 * - 录音期间不显示 partial，也不写输入框；
 * - 停止后把整段 PCM16 拼接，POST /api/voice/asr/transcribe 一次性转写；
 * - 转写文字 append 到开始录音时已有的草稿后写入 Composer（setPrompt），不自动发送；
 * - 打字 / 切换会话 / destroy 取消本次录音或转写，保留输入框当前内容；
 * - 本机模型由服务启动时自动安装（capabilities.install），安装中点击会提示等待；
 * - 达到 5 分钟上限自动停止并转写。
 */

import type { VoiceCapabilities } from '@mazi/libs';
import { reactive } from 'vue';
import { AudioCapture, isCaptureSupported, mapCaptureError } from './capture.ts';
import { fetchVoiceCapabilities, toVoiceErrorInfo, transcribePcm } from './local-asr.ts';
import { voiceSettings } from './settings.ts';
import { appendTranscript, sanitizeTranscript, shouldDiscardFinal } from './text.ts';
import type { VoiceErrorInfo } from './types.ts';

export type VoicePhase = 'off' | 'requesting' | 'armed' | 'finalizing' | 'error';

export interface VoiceUiState {
    phase: VoicePhase;
    supported: boolean;
    insecureContext: boolean;
    /** 本机引擎是否可用（模型 + 推理进程已就绪）。 */
    modelInstalled: boolean;
    /** 服务是否正在自动安装模型。 */
    installRunning: boolean;
    engine: 'local' | 'none';
    /** 当前麦克风电平 0..1（录音中的波形 / 诊断用）。 */
    level: number;
    error: string;
    notice: string;
}

export interface VoiceControllerOptions {
    /** 把识别文本写入 Composer（ChatMain → emit('update:prompt')）。 */
    setPrompt: (text: string) => void;
}

const CAPS_POLL_MS = 1500;
/** 采集目标采样率（capture.ts 的 Worklet 会重采样到该值）。 */
export const CAPTURE_SAMPLE_RATE = 16_000;
/** 单次录音上限 5 分钟：更长音频后端不接受，达到后自动停止并转写。 */
export const MAX_RECORD_MS = 5 * 60_000;
const MAX_RECORD_SAMPLES = Math.round((CAPTURE_SAMPLE_RATE * MAX_RECORD_MS) / 1000);

/** 把逐帧 PCM 复制品拼接成一整段（停止录音时调用一次）。 */
export function concatPcm(chunks: readonly Int16Array[]): Int16Array {
    let total = 0;
    for (const chunk of chunks) total += chunk.length;
    const merged = new Int16Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
    }
    return merged;
}

function createState(): VoiceUiState {
    return {
        phase: 'off',
        supported: false,
        insecureContext: false,
        modelInstalled: false,
        installRunning: false,
        engine: 'none',
        level: 0,
        error: '',
        notice: '',
    };
}

export class VoiceController {
    readonly state = reactive<VoiceUiState>(createState());

    private readonly options: VoiceControllerOptions;
    private prompt = '';
    private basePrompt = '';
    private capabilities: VoiceCapabilities | null = null;
    private capture: AudioCapture | null = null;
    /** 逐帧拷贝的 PCM16（16kHz mono）；停止时拼接后清空。 */
    private chunks: Int16Array[] = [];
    private totalSamples = 0;
    private recording = false;
    private starting = false;
    private stopping = false;
    private disposed = false;
    private operationId = 0;
    private pendingStop: Promise<void> | null = null;
    private transcribeAbort: AbortController | null = null;
    private capsPollTimer: ReturnType<typeof setTimeout> | null = null;
    private removeShortcut: (() => void) | null = null;

    constructor(options: VoiceControllerOptions) {
        this.options = options;
    }

    get isRecording(): boolean {
        return this.recording || this.starting || this.stopping;
    }

    async init(): Promise<void> {
        if (this.disposed) return;
        this.updateSupport();
        this.installShortcut();
        await this.refreshCapabilities();
    }

    destroy(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.cancelRecording();
        this.clearCapsPoll();
        this.removeShortcut?.();
        this.removeShortcut = null;
    }

    /** Composer 草稿变化（用户输入 / 提交后清空）。 */
    syncPrompt(text: string): void {
        this.prompt = typeof text === 'string' ? text : '';
    }

    async refresh(): Promise<void> {
        this.updateSupport();
        await this.refreshCapabilities();
    }

    /** 切换会话：停止录音 / 转写，不把旧会话文本带过去。 */
    resetConversation(): void {
        this.cancelRecording();
        this.state.notice = '';
        this.state.error = '';
    }

    /** 麦克风按钮：开始 / 停止。 */
    toggle(): void {
        if (this.isRecording) {
            void this.stopRecording();
        } else {
            void this.startRecording();
        }
    }

    async startRecording(): Promise<void> {
        if (this.disposed || this.isRecording) return;
        this.updateSupport();
        if (!this.state.supported) {
            this.state.phase = 'error';
            this.state.error = this.state.insecureContext
                ? '当前地址不是安全上下文，浏览器禁止麦克风。请用 http://localhost 或 HTTPS 打开。'
                : '当前浏览器不支持麦克风采集。';
            return;
        }

        // 先进入 requesting：能力刷新（安装刚完成时）与打开麦克风期间都不允许重复点击。
        this.starting = true;
        this.state.phase = 'requesting';
        this.state.error = '';
        this.state.notice = '';
        this.state.level = 0;
        this.state.engine = 'local';

        try {
            // 能力可能因模型刚安装完成而刚变为可用：点击时重新确认一次。
            let local = this.capabilities?.engines.local;
            if (!local?.available) {
                await this.refreshCapabilities();
                if (this.disposed || !this.starting) return;
                local = this.capabilities?.engines.local;
            }
            if (!local?.available) {
                this.starting = false;
                this.state.phase = 'error';
                this.state.engine = 'none';
                this.state.error = this.state.installRunning
                    ? '本机语音模型正在自动安装，请稍候再点麦克风。'
                    : '本机语音模型不可用，请检查服务日志或设置页。';
                return;
            }

            const operation = ++this.operationId;
            this.basePrompt = this.prompt;
            this.chunks = [];
            this.totalSamples = 0;

            const capture = new AudioCapture();
            await capture.start({
                deviceId: voiceSettings.inputDeviceId,
                sampleRate: CAPTURE_SAMPLE_RATE,
                onFrame: (frame) => {
                    if (operation !== this.operationId) return;
                    if (!this.recording && !this.starting) return;
                    // 必须复制：Worklet 每帧复用/释放底层 buffer，只存引用会得到旧数据。
                    const pcm = new Int16Array(frame.pcm);
                    this.chunks.push(pcm);
                    this.totalSamples += pcm.length;
                    this.state.level = frame.level;
                    if (this.totalSamples >= MAX_RECORD_SAMPLES) {
                        this.state.notice = '已达到 5 分钟录音上限，正在转写…';
                        void this.stopRecording();
                    }
                },
                onError: (error) => {
                    if (operation === this.operationId) this.fail(error);
                },
            });
            if (operation !== this.operationId || this.disposed || !this.starting) {
                capture.stop();
                return;
            }
            this.capture = capture;
            this.recording = true;
            this.starting = false;
            this.state.phase = 'armed';
        } catch (error) {
            if (this.disposed || !this.starting) return;
            this.starting = false;
            this.stopCapture();
            this.fail(this.toVoiceError(error));
        }
    }

    stopRecording(): Promise<void> {
        if (this.pendingStop) return this.pendingStop;
        const pending = this.doStopRecording().finally(() => {
            if (this.pendingStop === pending) this.pendingStop = null;
        });
        this.pendingStop = pending;
        return pending;
    }

    private async doStopRecording(): Promise<void> {
        if (this.starting) {
            this.cancelRecording();
            return;
        }
        if (!this.recording || this.stopping) return;
        this.stopping = true;
        this.recording = false;
        this.state.phase = 'finalizing';
        this.state.level = 0;
        this.stopCapture();

        const operation = this.operationId;
        const chunks = this.chunks;
        this.chunks = [];
        this.totalSamples = 0;

        const merged = concatPcm(chunks);
        const pcm =
            merged.length > MAX_RECORD_SAMPLES ? merged.subarray(0, MAX_RECORD_SAMPLES) : merged;
        if (pcm.length === 0) {
            this.failWithMessage('没听清，请重试');
            return;
        }

        const abort = new AbortController();
        this.transcribeAbort = abort;
        try {
            const result = await transcribePcm(pcm, {
                sampleRate: CAPTURE_SAMPLE_RATE,
                language: voiceSettings.language,
                signal: abort.signal,
            });
            // 被取消（打字 / 切会话 / destroy）时丢弃结果，保留输入框内容。
            if (operation !== this.operationId || this.disposed) return;
            const text = sanitizeTranscript(result?.text);
            if (!text || shouldDiscardFinal(text)) {
                this.failWithMessage('没听清，请重试');
                return;
            }
            this.applyTranscript(text);
            this.finishSession();
        } catch (error) {
            if (operation !== this.operationId || this.disposed) return;
            this.failWithMessage(this.toVoiceError(error).message || '语音转写失败，请重试');
        } finally {
            if (this.transcribeAbort === abort) this.transcribeAbort = null;
        }
    }

    /** 提交前调用：若正在录音 / 转写，先等停止与转写完成，再允许发送。 */
    async onSubmit(): Promise<boolean> {
        if (this.pendingStop) await this.pendingStop;
        else if (this.recording || this.starting) await this.stopRecording();
        return true;
    }

    /** 用户开始打字：取消本次录音 / 转写，让键盘输入接管。 */
    onUserInput(): void {
        if (this.isRecording) this.cancelRecording();
    }

    private applyTranscript(text: string): void {
        const next = appendTranscript(this.basePrompt, text);
        this.prompt = next;
        this.options.setPrompt(next);
    }

    /** 正常结束：回到 off，保留输入框内容。 */
    private finishSession(): void {
        this.recording = false;
        this.starting = false;
        this.stopping = false;
        this.chunks = [];
        this.totalSamples = 0;
        this.state.phase = 'off';
        this.state.level = 0;
        this.state.engine = 'none';
        this.state.notice = '';
    }

    /** 录音已停止但转写失败 / 没听清：显示错误行，输入框保持原样。 */
    private failWithMessage(message: string): void {
        this.recording = false;
        this.starting = false;
        this.stopping = false;
        this.stopCapture();
        this.chunks = [];
        this.totalSamples = 0;
        this.state.phase = 'error';
        this.state.error = message;
        this.state.level = 0;
        this.state.engine = 'none';
        this.state.notice = '';
    }

    private fail(error: VoiceErrorInfo): void {
        const message = error.message || '语音识别失败';
        this.cancelRecording();
        this.state.phase = 'error';
        this.state.error = message;
    }

    /** 取消本次录音 / 转写（不修改输入框）。 */
    private cancelRecording(): void {
        this.operationId += 1;
        this.stopCapture();
        this.transcribeAbort?.abort();
        this.transcribeAbort = null;
        this.chunks = [];
        this.totalSamples = 0;
        this.recording = false;
        this.starting = false;
        this.stopping = false;
        this.state.phase = 'off';
        this.state.level = 0;
        this.state.engine = 'none';
        this.state.notice = '';
    }

    private stopCapture(): void {
        this.capture?.stop();
        this.capture = null;
    }

    private toVoiceError(error: unknown): VoiceErrorInfo {
        if (error instanceof DOMException) return mapCaptureError(error);
        return toVoiceErrorInfo(error);
    }

    private updateSupport(): void {
        const win = typeof window !== 'undefined' ? window : null;
        this.state.insecureContext = Boolean(win && win.isSecureContext === false);
        this.state.supported = isCaptureSupported();
    }

    private async refreshCapabilities(): Promise<void> {
        this.clearCapsPoll();
        try {
            const capabilities = await fetchVoiceCapabilities();
            if (this.disposed) return;
            this.capabilities = capabilities;
            this.state.modelInstalled = Boolean(capabilities.engines.local.available);
            this.state.installRunning = capabilities.install?.status === 'running';
            if (this.state.installRunning) this.scheduleCapsPoll();
        } catch {
            if (this.disposed) return;
            this.capabilities = null;
            this.state.modelInstalled = false;
            this.state.installRunning = false;
        }
    }

    /** 模型自动安装中：每 1.5s 拉一次 capabilities，供按钮可用性判断。 */
    private scheduleCapsPoll(): void {
        if (this.capsPollTimer !== null || this.disposed) return;
        this.capsPollTimer = setTimeout(() => {
            this.capsPollTimer = null;
            if (!this.disposed) void this.refreshCapabilities();
        }, CAPS_POLL_MS);
    }

    private clearCapsPoll(): void {
        if (this.capsPollTimer !== null) {
            clearTimeout(this.capsPollTimer);
            this.capsPollTimer = null;
        }
    }

    private installShortcut(): void {
        if (typeof window === 'undefined' || this.removeShortcut) return;
        const onKeydown = (event: KeyboardEvent) => {
            if (!matchesVoiceShortcut(event, voiceSettings.shortcut)) return;
            event.preventDefault();
            this.toggle();
        };
        window.addEventListener('keydown', onKeydown);
        this.removeShortcut = () => window.removeEventListener('keydown', onKeydown);
    }
}

/** 'Mod+Shift+M'（Mod = ⌘/Ctrl）。 */
export function matchesVoiceShortcut(event: KeyboardEvent, shortcut: string): boolean {
    if (!shortcut) return false;
    const parts = shortcut
        .split('+')
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean);
    const key = parts[parts.length - 1] ?? '';
    if (!key) return false;
    const wantsMeta = parts.includes('mod') || parts.includes('meta') || parts.includes('cmd');
    const wantsShift = parts.includes('shift');
    const wantsAlt = parts.includes('alt') || parts.includes('option');
    const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
    const modOk = wantsMeta ? (isMac ? event.metaKey : event.ctrlKey) : !event.metaKey;
    if (!modOk) return false;
    if (wantsShift !== event.shiftKey) return false;
    if (wantsAlt !== event.altKey) return false;
    return event.key.toLowerCase() === key;
}
