/**
 * 语音输入控制器（本机识别 only）。
 *
 * 交互（按用户要求收敛）：
 * - 点击麦克风开始录音；再次点击停止识别；
 * - 识别文字直接写入 Composer 输入框（partial 也实时写入），不显示独立识别列；
 * - 不自动发送；用户停止后自行点发送；
 * - 不启用浏览器 Web Speech，不使用云端识别；
 * - 本机模型由服务启动时自动安装（capabilities.install），安装中点击会提示等待。
 */
import { reactive } from 'vue';
import type { VoiceCapabilities } from '@mazi/libs';
import { AudioCapture, isCaptureSupported, mapCaptureError } from './capture.ts';
import {
    fetchVoiceCapabilities,
    LocalAsrClient,
    toVoiceErrorInfo,
} from './local-asr.ts';
import { appendTranscript, sanitizeTranscript } from './text.ts';
import { voiceSettings } from './settings.ts';
import type { VoiceErrorInfo } from './types.ts';

export type VoicePhase =
    | 'off'
    | 'requesting'
    | 'armed'
    | 'partial'
    | 'finalizing'
    | 'error';

export interface VoiceUiState {
    phase: VoicePhase;
    supported: boolean;
    insecureContext: boolean;
    /** 本机引擎是否可用（模型 + sherpa 已就绪）。 */
    modelInstalled: boolean;
    /** 服务是否正在自动安装模型。 */
    installRunning: boolean;
    engine: 'local' | 'none';
    partial: string;
    level: number;
    error: string;
    notice: string;
}

export interface VoiceControllerOptions {
    /** 把识别文本写入 Composer（ChatMain → emit('update:prompt')）。 */
    setPrompt: (text: string) => void;
}

const CAPS_POLL_MS = 1500;

function createState(): VoiceUiState {
    return {
        phase: 'off',
        supported: false,
        insecureContext: false,
        modelInstalled: false,
        installRunning: false,
        engine: 'none',
        partial: '',
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
    private client: LocalAsrClient | null = null;
    private capture: AudioCapture | null = null;
    private recording = false;
    private starting = false;
    private stopping = false;
    private disposed = false;
    private operationId = 0;
    private pendingStop: Promise<void> | null = null;
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

    /** 切换会话：停止录音，不把旧会话文本带过去。 */
    resetConversation(): void {
        this.cancelRecording();
        this.state.notice = '';
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
        const local = this.capabilities?.engines.local;
        if (!local?.available) {
            this.state.phase = 'error';
            this.state.error = this.state.installRunning
                ? '本机语音模型正在自动安装，请稍候再点麦克风。'
                : '本机语音模型不可用，请检查服务日志或设置页。';
            return;
        }

        const operation = ++this.operationId;
        this.basePrompt = this.prompt;
        this.state.partial = '';
        this.state.error = '';
        this.state.notice = '';
        this.state.phase = 'requesting';
        this.state.engine = 'local';
        this.starting = true;

        try {
            const client = new LocalAsrClient({
                language: voiceSettings.language,
                modelId: local.modelId,
                onPartial: (text) => this.handlePartial(client, text),
                onFinal: (text) => this.handleFinal(client, text),
                onError: (error) => this.handleError(client, error),
            });
            this.client = client;
            await client.start();
            if (operation !== this.operationId || this.disposed) {
                client.cancel();
                return;
            }

            const capture = new AudioCapture();
            await capture.start({
                deviceId: voiceSettings.inputDeviceId,
                onFrame: (frame) => {
                    this.state.level = frame.level;
                    if (this.recording) this.client?.pushPcm(frame.pcm);
                },
                onError: (error) => this.fail(error),
            });
            if (operation !== this.operationId || this.disposed) {
                capture.stop();
                client.cancel();
                return;
            }
            this.capture = capture;
            this.recording = true;
            this.starting = false;
            this.state.phase = 'armed';
        } catch (error) {
            if (operation !== this.operationId || this.disposed) return;
            this.starting = false;
            this.cleanup();
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
        if (!this.recording || !this.client) return;
        this.stopping = true;
        this.recording = false;
        this.state.phase = 'finalizing';
        this.capture?.stop();
        this.capture = null;
        const client = this.client;
        try {
            await client.end();
        } finally {
            if (this.client === client) this.finishSession(true);
        }
    }

    /** 提交前调用：若正在录音/正在结束，先等 final 落定，再允许发送。 */
    async onSubmit(): Promise<boolean> {
        if (this.pendingStop) await this.pendingStop;
        if (this.recording || this.starting) {
            await this.stopRecording();
        }
        return true;
    }

    /** 用户开始打字：取消本次录音，让键盘输入接管。 */
    onUserInput(): void {
        if (this.isRecording) this.cancelRecording();
    }

    private handlePartial(client: LocalAsrClient, text: string): void {
        if (this.client !== client || this.stopping) return;
        const clean = sanitizeTranscript(text);
        this.state.partial = clean;
        this.state.phase = clean ? 'partial' : 'armed';
        if (clean) this.applyPrompt(clean);
    }

    private handleFinal(client: LocalAsrClient, text: string): void {
        if (this.client !== client) return;
        const clean = sanitizeTranscript(text);
        this.state.partial = clean;
        if (clean) this.applyPrompt(clean);
        this.finishSession(false);
    }

    private handleError(client: LocalAsrClient, error: VoiceErrorInfo): void {
        if (this.client !== client) return;
        this.fail(error);
    }

    private finishSession(usePartial: boolean): void {
        if (usePartial) {
            const partial = this.state.partial;
            if (partial) this.applyPrompt(partial);
        }
        this.cleanup();
        this.recording = false;
        this.starting = false;
        this.stopping = false;
        this.state.phase = 'off';
        this.state.partial = '';
        this.state.level = 0;
        this.state.engine = 'none';
    }

    private cancelRecording(): void {
        this.operationId += 1;
        this.cleanup();
        this.recording = false;
        this.starting = false;
        this.stopping = false;
        this.state.phase = 'off';
        this.state.partial = '';
        this.state.level = 0;
        this.state.engine = 'none';
    }

    private cleanup(): void {
        this.capture?.stop();
        this.capture = null;
        const client = this.client;
        this.client = null;
        client?.cancel();
    }

    private applyPrompt(partial: string): void {
        const text = appendTranscript(this.basePrompt, partial);
        this.prompt = text;
        this.options.setPrompt(text);
    }

    private fail(error: VoiceErrorInfo): void {
        const message = error.message || '语音识别失败';
        const partial = this.state.partial;
        if (partial) this.applyPrompt(partial);
        this.cancelRecording();
        this.state.phase = 'error';
        this.state.error = message;
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
            this.capabilities = capabilities;
            this.state.modelInstalled = Boolean(capabilities.engines.local.available);
            this.state.installRunning = capabilities.install?.status === 'running';
            if (this.state.installRunning) this.scheduleCapsPoll();
        } catch {
            this.capabilities = null;
            this.state.modelInstalled = false;
            this.state.installRunning = false;
        }
    }

    private capabilities: VoiceCapabilities | null = null;

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
    const parts = shortcut.split('+').map((part) => part.trim().toLowerCase()).filter(Boolean);
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
