/**
 * 语音输入编排（设计 §5 / §11）。
 *
 * 职责：
 * - init() 拉 capabilities（后端未启动也不阻塞浏览器引擎降级）；
 * - 引擎解析：local → browser-on-device → browser-cloud（需显式同意）→ none；
 * - 采集 / VAD / partial / final 驱动状态机与 Composer 文本注入；
 * - 自动发送倒计时（可被输入取消）、暂停规则（失焦 / 执行中 / 空闲）、
 *   多标签页 BroadcastChannel 抢占、模型安装 / 诊断。
 *
 * 不模拟键盘事件、不改 App.vue：final 文本只通过 options.setPrompt 注入，
 * 自动发送由 options.submit（ChatMain 在 nextTick 后 emit('submit')）完成。
 */

import type { VoiceCapabilities, VoiceLimits, VoiceModelInfo } from '@mazi/libs';
import { reactive, watch } from 'vue';
import { BrowserAsrClient, type BrowserAsrDetection, detectBrowserAsr } from './browser-asr.ts';
import { AudioCapture, isCaptureSupported, mapCaptureError, type PcmFrame } from './capture.ts';
import {
    deleteVoiceModel,
    fetchVoiceCapabilities,
    fetchVoiceModelDownload,
    LocalAsrClient,
    startVoiceModelDownload,
    toVoiceErrorInfo,
} from './local-asr.ts';
import { saveVoiceSettings, voiceSettings } from './settings.ts';
import { createVoiceState, reduceVoiceState } from './state.ts';
import { appendTranscript, formatPartial, sanitizeTranscript, shouldDiscardFinal } from './text.ts';
import type {
    VoiceControllerOptions,
    VoiceControllerState,
    VoiceErrorInfo,
    VoicePauseReason,
    VoiceRuntimeEngine,
    VoiceSettings,
    VoiceState,
} from './types.ts';
import { EnergyVad, type VadEvent } from './vad.ts';

interface Utterance {
    client: LocalAsrClient;
    buffer: Int16Array[];
    ready: boolean;
    finalizing: boolean;
    finishPending: boolean;
    partialText: string;
}

const PRE_ROLL_FRAMES = 3;
const MAX_UTTERANCE_BUFFER = 80;
const OWNERSHIP_TIMEOUT_MS = 220;
const DOWNLOAD_POLL_MS = 800;

function createInitialState(): VoiceControllerState {
    return {
        ...createVoiceState({ enabled: voiceSettings.enabled }),
        supported: false,
        insecureContext: false,
        browserSupported: false,
        browserOnDevice: false,
        browserConsentRequired: false,
        capabilities: null,
        capabilitiesError: '',
        modelId: null,
        modelInstalled: false,
        modelStatus: 'unknown',
        downloadProgress: 0,
        downloadError: '',
        installing: false,
        level: 0,
        notice: '',
        tabConflict: false,
        micTesting: false,
        micTestLevel: 0,
        enginePreference: voiceSettings.engine,
    };
}

export class VoiceController {
    readonly state: VoiceControllerState;

    private readonly options: VoiceControllerOptions;
    private machine: VoiceState;
    private disposed = false;
    private capture: AudioCapture | null = null;
    private browser: BrowserAsrClient | null = null;
    private vad: EnergyVad | null = null;
    private utterance: Utterance | null = null;
    private preRoll: Int16Array[] = [];
    private limits: VoiceLimits | null = null;
    private knownPrompt = '';
    private busy = false;
    private wantEnabled = false;
    private manualPaused = false;
    private lastBusyPause = false;
    private timers = new Set<ReturnType<typeof setTimeout>>();
    private countdownTimer: ReturnType<typeof setTimeout> | null = null;
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    private blurTimer: ReturnType<typeof setTimeout> | null = null;
    private channel: BroadcastChannel | null = null;
    private readonly tabId = Math.random().toString(36).slice(2);
    private pendingOwnership: ((granted: boolean) => void) | null = null;
    private ownershipTimer: ReturnType<typeof setTimeout> | null = null;
    private forceOwnership = false;
    private autoResume = false;
    private autoStartArmed = false;
    private removeAutoStart: (() => void) | null = null;
    private removeGlobalListeners: (() => void) | null = null;
    private stopSettingsWatch: (() => void) | null = null;
    private removeModelListener: (() => void) | null = null;
    private capsPollTimer: ReturnType<typeof setTimeout> | null = null;
    private downloadToken = 0;

    constructor(options: VoiceControllerOptions) {
        this.options = options;
        this.machine = createVoiceState({ enabled: voiceSettings.enabled });
        this.state = reactive(createInitialState());
        this.knownPrompt = '';
    }

    get promptDraft(): string {
        return this.knownPrompt;
    }

    get isBusy(): boolean {
        return this.busy;
    }

    /* ------------------------------ lifecycle ------------------------------ */

    async init(): Promise<void> {
        if (this.disposed) return;
        this.applyLocalSettings();
        this.updateAvailability();
        this.installGlobalListeners();
        this.installSettingsWatch();
        this.setupChannel();
        await Promise.all([this.refreshCapabilities(), this.detectBrowser()]);
        this.scheduleIdlePause();
        this.armAutoStart();
        if (typeof window !== 'undefined') {
            const onModelsChanged = () => {
                void this.refresh();
            };
            window.addEventListener('mazi:voice-models-changed', onModelsChanged);
            this.removeModelListener = () => {
                window.removeEventListener('mazi:voice-models-changed', onModelsChanged);
            };
        }
    }

    destroy(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.cancelCountdown();
        this.clearIdlePause();
        if (this.blurTimer) {
            clearTimeout(this.blurTimer);
            this.blurTimer = null;
        }
        this.stopEngine();
        this.releaseOwnership();
        this.removeAutoStart?.();
        this.removeAutoStart = null;
        this.autoStartArmed = false;
        this.removeGlobalListeners?.();
        this.removeGlobalListeners = null;
        this.stopSettingsWatch?.();
        this.stopSettingsWatch = null;
        this.clearCapsPoll();
        this.removeModelListener?.();
        this.removeModelListener = null;
        try {
            this.channel?.close();
        } catch {
            // Ignore.
        }
        this.channel = null;
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
        this.downloadToken += 1;
    }

    /** Composer 草稿外部变更（用户输入 / 切换会话 / 提交后清空）。 */
    syncPrompt(text: string): void {
        this.knownPrompt = typeof text === 'string' ? text : '';
    }

    /** 切换会话：取消倒计时、丢弃当前 utterance，避免串话；保持监听。 */
    resetConversation(): void {
        this.cancelCountdown();
        this.resetUtterance();
        this.vad?.reset();
        this.state.partial = '';
        this.dispatch({ type: 'reset' });
        this.scheduleIdlePause();
    }

    /** 设置页/后端状态变化后可手动刷新。 */
    async refresh(): Promise<void> {
        this.applyLocalSettings();
        this.updateAvailability();
        await Promise.all([this.refreshCapabilities(), this.detectBrowser()]);
    }

    private applyLocalSettings(): void {
        this.state.enginePreference = voiceSettings.engine;
        this.vad?.update({
            endpointSilenceMs: voiceSettings.endpointSilenceMs,
            maxUtteranceMs: voiceSettings.maxUtteranceMs,
            sensitivity: voiceSettings.sensitivity,
        });
    }

    /**
     * 设置页改动不会重建引擎，但已挂载的 controller 要即时同步：
     * enabled 关闭 → 释放采集；引擎/灵敏度/端点/语言变化 → 更新 VAD 与下一句参数。
     */
    private installSettingsWatch(): void {
        if (this.stopSettingsWatch) return;
        this.stopSettingsWatch = watch(
            () => ({ ...voiceSettings }),
            (next, previous) => {
                if (!previous) return;
                this.onSettingsChanged(previous, next);
            },
        );
    }

    private onSettingsChanged(previous: VoiceSettings, next: VoiceSettings): void {
        if (
            previous.engine !== next.engine ||
            previous.endpointSilenceMs !== next.endpointSilenceMs ||
            previous.maxUtteranceMs !== next.maxUtteranceMs ||
            previous.sensitivity !== next.sensitivity ||
            previous.language !== next.language ||
            previous.inputDeviceId !== next.inputDeviceId
        ) {
            this.applyLocalSettings();
        }
        if (previous.enabled !== next.enabled) {
            if (!next.enabled) {
                this.manualPaused = false;
                this.disable();
            } else {
                this.wantEnabled = true;
                this.armAutoStart();
            }
        }
        if (
            previous.pauseOnBusy !== next.pauseOnBusy &&
            next.pauseOnBusy &&
            this.busy &&
            this.isActive()
        ) {
            this.pause('busy');
        }
        if (previous.pauseOnBlur !== next.pauseOnBlur && next.pauseOnBlur) {
            const hidden = typeof document !== 'undefined' && document.hidden;
            if (hidden && this.isActive()) this.pause('blur');
        }
        if (previous.browserConsent !== next.browserConsent) {
            if (next.browserConsent && this.state.browserConsentRequired) {
                this.state.browserConsentRequired = false;
                this.state.notice = '';
            }
            if (!next.browserConsent && this.state.engine === 'browser-cloud' && this.isActive()) {
                this.pause('consent');
                this.state.browserConsentRequired = true;
                this.state.notice = '浏览器识别已关闭，需重新确认后才能启用。';
            }
        }
    }

    private updateAvailability(): void {
        const win = typeof window !== 'undefined' ? window : null;
        this.state.insecureContext = Boolean(win && win.isSecureContext === false);
        this.state.supported = isCaptureSupported();
    }

    /* ------------------------------- engines ------------------------------- */

    private async refreshCapabilities(): Promise<void> {
        this.state.capabilitiesError = '';
        try {
            const capabilities = await fetchVoiceCapabilities();
            this.state.capabilities = capabilities;
            this.applyCapabilities(capabilities);
        } catch (error) {
            // 后端未启动 / 端点未实现：不整体报错，浏览器识别仍可降级使用。
            this.state.capabilities = null;
            this.state.capabilitiesError = toVoiceErrorInfo(error).message;
            if (this.state.modelStatus === 'downloading' || this.state.installing) {
                // 自动安装轮询失败：停止轮询并明确提示，避免一直卡在进度条。
                this.clearCapsPoll();
                this.state.installing = false;
                this.state.modelStatus = 'error';
                this.state.downloadError = '无法连接本机语音服务，自动安装状态未知。';
            } else {
                this.state.modelStatus = 'unknown';
            }
        }
    }

    private applyCapabilities(capabilities: VoiceCapabilities): void {
        const local = capabilities.engines?.local;
        const models: VoiceModelInfo[] = capabilities.models ?? [];
        const installedModel =
            models.find((model) => model.installed) ??
            models.find((model) => model.recommended) ??
            null;
        this.state.modelId = local?.modelId ?? installedModel?.id ?? this.state.modelId ?? null;
        this.state.modelInstalled = Boolean(local?.available) || Boolean(installedModel?.installed);
        const wasDownloading = this.state.modelStatus === 'downloading' || this.state.installing;
        this.state.modelStatus = this.state.modelInstalled ? 'ready' : 'missing';

        const install = capabilities.install;
        if (!install) {
            // 旧版后端没有自动安装状态：保持按模型安装情况推导。
            this.clearCapsPoll();
            this.state.installing = false;
            this.state.downloadError = '';
            this.state.downloadProgress = this.state.modelInstalled ? 1 : 0;
            return;
        }
        const progress = Number.isFinite(install.progress)
            ? Math.min(1, Math.max(0, install.progress))
            : 0;
        this.state.modelId = install.modelId || this.state.modelId;
        if (install.status === 'running') {
            this.state.modelStatus = 'downloading';
            this.state.installing = true;
            this.state.downloadProgress = progress;
            this.state.downloadError = '';
            this.scheduleCapsPoll();
            return;
        }
        if (install.status === 'done') {
            this.state.modelStatus = 'ready';
            this.state.modelInstalled = true;
            this.state.installing = false;
            this.state.downloadProgress = 1;
            this.state.downloadError = '';
            this.clearCapsPoll();
            if (wasDownloading) this.state.notice = '本机语音模型已就绪。';
            return;
        }
        // install.status === 'error'
        this.state.modelStatus = 'error';
        this.state.installing = false;
        this.state.downloadProgress = progress;
        this.state.downloadError =
            install.error || '本机语音模型自动安装失败，服务重启时会再次尝试。';
        this.clearCapsPoll();
    }

    /** 自动安装中：每 1.5s 重新拉 capabilities，直到 done/error。 */
    private scheduleCapsPoll(): void {
        if (this.capsPollTimer !== null) return;
        this.capsPollTimer = this.addTimer(() => {
            this.capsPollTimer = null;
            if (this.disposed) return;
            if (this.state.modelStatus !== 'downloading') return;
            void this.refreshCapabilities();
        }, 1500);
    }

    private clearCapsPoll(): void {
        if (this.capsPollTimer === null) return;
        this.clearTimer(this.capsPollTimer);
        this.capsPollTimer = null;
    }

    private async detectBrowser(): Promise<void> {
        const detection: BrowserAsrDetection = await detectBrowserAsr(voiceSettings.language);
        this.state.browserSupported = detection.supported;
        this.state.browserOnDevice = detection.onDevice;
    }

    /** auto：local → browser-on-device → browser-cloud → none（lead 指定顺序）。 */
    private resolveEngine(): { engine: VoiceRuntimeEngine; reason?: string } {
        const preference = voiceSettings.engine;
        const local = this.state.capabilities?.engines?.local;
        const localReady = Boolean(local?.available);

        if (preference === 'local') {
            return localReady
                ? { engine: 'local' }
                : {
                      engine: 'none',
                      reason:
                          this.state.modelStatus === 'downloading'
                              ? '本机语音模型正在自动安装，请稍候'
                              : local?.reason || '本机语音模型尚未就绪。',
                  };
        }
        if (preference === 'browser-on-device') {
            return this.state.browserOnDevice
                ? { engine: 'browser-on-device' }
                : { engine: 'none', reason: '浏览器本机识别不可用。' };
        }
        if (localReady) return { engine: 'local' };
        // 本机模型由服务启动时自动安装：安装中不回退浏览器云识别，避免误用云端。
        if (this.state.modelStatus === 'downloading') {
            return { engine: 'none', reason: '本机语音模型正在自动安装，请稍候' };
        }
        if (this.state.browserSupported && this.state.browserOnDevice) {
            return { engine: 'browser-on-device' };
        }
        if (this.state.browserSupported) return { engine: 'browser-cloud' };
        return {
            engine: 'none',
            reason: local?.reason || '本机识别不可用，且当前浏览器不支持 Web Speech。',
        };
    }

    /* ------------------------------- enable -------------------------------- */

    async enable(): Promise<void> {
        if (this.disposed) return;
        if (this.isActive()) return;
        this.updateAvailability();
        if (!this.state.supported) {
            this.fail({
                code: 'engine_unavailable',
                message: this.state.insecureContext
                    ? '当前地址不是安全上下文，浏览器禁止麦克风。请用 http://localhost 或 HTTPS 打开。'
                    : '当前浏览器不支持麦克风采集。',
                retryable: false,
            });
            return;
        }

        this.wantEnabled = true;
        this.manualPaused = false;
        this.lastBusyPause = false;
        this.state.browserConsentRequired = false;
        this.state.notice = '';
        this.dispatch({ type: 'enable' });

        if (voiceSettings.pauseOnBusy && this.busy) {
            this.state.notice = '执行中，语音已暂歇；本轮结束后自动恢复。';
            this.dispatch({ type: 'pause', reason: 'busy' });
            this.lastBusyPause = true;
            return;
        }

        const { engine, reason } = this.resolveEngine();
        if (engine === 'none') {
            if (this.state.modelStatus === 'downloading') {
                // 模型自动安装中：暂歇等待，不算错误，也不回退浏览器云识别。
                this.pause('model');
                this.state.notice = '本机语音模型正在自动安装，请稍候；完成后点麦克风即可。';
                this.scheduleCapsPoll();
                return;
            }
            this.fail({
                code: 'engine_unavailable',
                message: reason ? `${reason} 已切回文字输入。` : '语音识别不可用，已切回文字输入。',
                retryable: true,
            });
            return;
        }

        // 浏览器云识别：首次必须显式同意（音频会发送给浏览器厂商）。
        if (engine === 'browser-cloud' && !voiceSettings.browserConsent) {
            this.state.browserConsentRequired = true;
            this.dispatch({ type: 'pause', reason: 'consent' });
            this.state.notice = '浏览器识别可能上传音频，需确认后才能启用。';
            return;
        }
        if (engine === 'browser-on-device') {
            this.state.notice = '浏览器本机识别（音频不出本机）。';
        }

        const owner = await this.requestOwnership();
        if (this.machine.phase !== 'requesting' || this.disposed) {
            this.releaseOwnership();
            return;
        }
        if (!owner) {
            this.state.tabConflict = true;
            this.dispatch({ type: 'pause', reason: 'other-tab' });
            this.state.notice = '另一标签页正在使用语音输入。点麦克风可接管。';
            return;
        }

        try {
            if (engine === 'local') {
                const started = await this.startLocalEngine();
                if (!started) {
                    this.releaseOwnership();
                    return;
                }
            } else {
                this.startBrowserEngine(engine);
            }
            if (this.machine.phase !== 'requesting' || this.disposed) {
                this.stopEngine();
                this.releaseOwnership();
                return;
            }
            this.dispatch({ type: 'ready', engine });
            this.state.engine = engine;
            this.scheduleIdlePause();
            this.state.notice = engine === 'browser-on-device' ? '浏览器本机识别已就绪。' : '';
        } catch (error) {
            this.releaseOwnership();
            if (this.autoResume) {
                this.autoResume = false;
                this.dispatch({ type: 'pause', reason: 'gesture' });
                this.state.notice = '回到前台了，点麦克风恢复语音输入。';
                return;
            }
            this.fail(mapCaptureError(error));
        } finally {
            this.autoResume = false;
        }
    }

    private isActive(): boolean {
        return (
            this.machine.phase === 'requesting' ||
            this.machine.phase === 'armed' ||
            this.machine.phase === 'capturing' ||
            this.machine.phase === 'partial' ||
            this.machine.phase === 'finalizing' ||
            this.machine.phase === 'committed'
        );
    }

    private async startLocalEngine(): Promise<boolean> {
        if (!this.state.modelInstalled) {
            this.fail({
                code: 'model_missing',
                message: '本机语音模型正在由服务自动安装（约 52MB，音频不会上传）。',
                retryable: true,
            });
            this.state.modelStatus = this.state.modelStatus === 'unknown' ? 'unknown' : 'missing';
            return false;
        }
        this.vad = new EnergyVad({
            endpointSilenceMs: voiceSettings.endpointSilenceMs,
            maxUtteranceMs: voiceSettings.maxUtteranceMs,
            sensitivity: voiceSettings.sensitivity,
        });
        const capture = new AudioCapture();
        this.capture = capture;
        await capture.start({
            deviceId: voiceSettings.inputDeviceId,
            onFrame: (frame) => this.handleLocalFrame(frame),
            onError: (error) => this.fail(error),
        });
        return true;
    }

    private startBrowserEngine(engine: 'browser-on-device' | 'browser-cloud'): void {
        const client = new BrowserAsrClient({
            language: voiceSettings.language,
            onDevice: engine === 'browser-on-device',
            onPartial: (text) => this.handleBrowserPartial(text),
            onFinal: (text) => this.handleBrowserFinal(text),
            onError: (error) => this.handleBrowserError(error),
        });
        this.browser = client;
        client.start();
    }

    /* -------------------------------- local -------------------------------- */

    private handleLocalFrame(frame: PcmFrame): void {
        if (this.disposed) return;
        this.state.level = frame.level;
        const vad = this.vad;
        if (!vad) return;
        const events = vad.feed(frame.level, frame.at);
        for (const event of events) {
            if (event.type === 'level') {
                this.state.level = event.level;
            } else if (event.type === 'start') {
                this.beginUtterance();
                this.pushUtteranceFrame(frame.pcm);
                this.clearIdlePause();
                this.state.notice = '';
            } else {
                this.finishUtterance(event);
            }
        }
        this.preRoll.push(frame.pcm);
        if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift();
    }

    private beginUtterance(): void {
        if (this.utterance) return;
        const client = new LocalAsrClient({
            language: voiceSettings.language,
            modelId: this.state.modelId ?? undefined,
            onPartial: (text, revision) => this.handleLocalPartial(client, text, revision),
            onFinal: (text) => this.handleLocalFinal(client, text),
            onError: (error) => this.handleLocalError(client, error),
        });
        const utterance: Utterance = {
            client,
            buffer: [...this.preRoll],
            ready: false,
            finalizing: false,
            finishPending: false,
            partialText: '',
        };
        this.utterance = utterance;
        void client
            .start()
            .then(() => {
                if (this.utterance !== utterance || this.disposed) return;
                utterance.ready = true;
                for (const pcm of utterance.buffer) client.pushPcm(pcm);
                utterance.buffer = [];
                if (utterance.finishPending) {
                    utterance.finishPending = false;
                    void client.end();
                }
            })
            .catch(() => {
                // client.start() 已回调 onError；这里只清掉现场。
                if (this.utterance === utterance) this.utterance = null;
            });
    }

    private pushUtteranceFrame(pcm: Int16Array): void {
        const utterance = this.utterance;
        if (!utterance || utterance.finalizing) return;
        if (utterance.ready) {
            utterance.client.pushPcm(pcm);
            return;
        }
        utterance.buffer.push(pcm);
        if (utterance.buffer.length > MAX_UTTERANCE_BUFFER) utterance.buffer.shift();
    }

    private finishUtterance(event: Extract<VadEvent, { type: 'end' }>): void {
        const utterance = this.utterance;
        if (!utterance || utterance.finalizing) return;
        this.dispatch({ type: 'endpoint' });
        if (event.tooShort) {
            this.resetUtterance();
            this.dispatch({ type: 'reset' });
            this.state.notice = '没听清，再说一次。';
            this.scheduleIdlePause();
            return;
        }
        utterance.finalizing = true;
        this.clearIdlePause();
        if (utterance.ready) {
            void utterance.client.end();
        } else {
            utterance.finishPending = true;
        }
    }

    private handleLocalPartial(client: LocalAsrClient, text: string, revision: number): void {
        const utterance = this.utterance;
        if (!utterance || utterance.client !== client || utterance.finalizing) return;
        utterance.partialText = text;
        this.dispatch({ type: 'partial', text, revision });
        this.state.partial = voiceSettings.showPartial ? formatPartial(text) : '';
    }

    private handleLocalFinal(client: LocalAsrClient, text: string): void {
        const utterance = this.utterance;
        if (!utterance || utterance.client !== client) return;
        this.commitFinal(text);
    }

    private handleLocalError(client: LocalAsrClient, error: VoiceErrorInfo): void {
        const utterance = this.utterance;
        if (utterance && utterance.client !== client) return;
        if (utterance?.finalizing && utterance.partialText) {
            // final 超时 / 失败：保留已识别到的最新 partial，避免整段丢失。
            const text = utterance.partialText;
            this.commitFinal(text);
            this.state.notice = '识别超时，已保留最新结果。';
            return;
        }
        this.utterance = null;
        this.fail(error);
    }

    /* ------------------------------- browser ------------------------------- */

    private handleBrowserPartial(text: string): void {
        if (this.machine.phase === 'armed' || this.machine.phase === 'committed') {
            this.dispatch({ type: 'vad-start' });
            this.clearIdlePause();
        }
        this.dispatch({ type: 'partial', text, revision: this.machine.revision + 1 });
        this.state.partial = voiceSettings.showPartial ? formatPartial(text) : '';
        this.state.level = 0.35;
    }

    private handleBrowserFinal(text: string): void {
        this.state.level = 0;
        this.commitFinal(text);
    }

    private handleBrowserError(error: VoiceErrorInfo): void {
        if (error.code === 'asr_failed' && /取消/.test(error.message)) return;
        if (error.code === 'forbidden' || error.code === 'engine_unavailable') {
            this.fail(error);
            return;
        }
        this.state.notice = error.message;
    }

    /* -------------------------------- commit ------------------------------- */

    /** final 落定：清洗 → 丢弃过短 → 追加草稿 → 自动发送倒计时。 */
    private commitFinal(rawText: string): void {
        const text = sanitizeTranscript(rawText);
        this.resetUtterance();
        this.vad?.reset();
        this.state.level = 0;
        if (this.machine.phase === 'armed' || this.machine.phase === 'committed') {
            // 浏览器识别可能直接给 final，没有 interim。
            this.dispatch({ type: 'vad-start' });
        }
        const minChars = this.limits?.minFinalChars ?? 2;
        if (shouldDiscardFinal(text, minChars)) {
            this.dispatch({ type: 'reset' });
            this.state.partial = '';
            this.state.notice = '没听清，再说一次。';
            this.scheduleIdlePause();
            return;
        }
        this.dispatch({ type: 'final', text });
        this.state.partial = '';
        this.state.lastFinal = text;
        const nextPrompt = appendTranscript(this.knownPrompt, text);
        this.knownPrompt = nextPrompt;
        this.options.setPrompt(nextPrompt);
        this.state.notice = '';
        if (voiceSettings.autoSend) {
            this.startCountdown();
        } else {
            this.scheduleIdlePause();
        }
    }

    /* ------------------------------- countdown ----------------------------- */

    private startCountdown(): void {
        this.cancelCountdown();
        const delay =
            this.options.sendDelayMs ?? Math.max(0, Math.round(voiceSettings.sendDelayMs));
        const endsAt = this.now() + delay;
        this.dispatch({ type: 'countdown', endsAt });
        this.countdownTimer = this.addTimer(() => {
            this.countdownTimer = null;
            this.dispatch({ type: 'countdown-cancel' });
            if (this.disposed) return;
            if (this.isBusy || this.options.canSubmit?.() === false) {
                this.state.notice = '执行中，已取消自动发送；可手动发送。';
                return;
            }
            this.options.submit();
            // 提交后立即清理本地已知草稿，避免下一句 final 追加到已发送文本。
            this.onSubmit();
        }, delay);
    }

    cancelCountdown(): void {
        if (this.countdownTimer) {
            this.clearTimer(this.countdownTimer);
            this.countdownTimer = null;
        }
        this.dispatch({ type: 'countdown-cancel' });
    }

    /** 用户打字 / 继续说话：取消倒计时并丢弃未 final 的 partial。 */
    onUserInput(): void {
        this.cancelCountdown();
        if (this.utterance) this.resetUtterance();
        this.vad?.reset();
        this.state.partial = '';
        this.dispatch({ type: 'user-input' });
    }

    /** 提交后清理（ChatMain 的 submit 前置调用）。 */
    onSubmit(): void {
        this.cancelCountdown();
        this.resetUtterance();
        this.vad?.reset();
        this.state.partial = '';
        this.knownPrompt = '';
        this.dispatch({ type: 'reset' });
        this.scheduleIdlePause();
    }

    /* ------------------------------- pause/resume --------------------------- */

    pause(reason: VoicePauseReason = 'manual'): void {
        if (this.disposed) return;
        if (!this.isActive() && this.machine.phase !== 'paused') return;
        this.dispatch({ type: 'pause', reason });
        this.stopEngine();
        this.cancelCountdown();
        this.clearIdlePause();
        this.manualPaused = reason === 'manual';
        this.wantEnabled = reason !== 'manual';
        switch (reason) {
            case 'manual':
                this.state.notice = '语音已暂停';
                break;
            case 'busy':
                this.state.notice = '执行中，语音已暂歇';
                break;
            case 'blur':
                this.state.notice = '语音输入已暂停（页面切到后台）';
                break;
            case 'idle':
                this.state.notice = '语音已自动暂停，点麦克风恢复';
                break;
            default:
                break;
        }
        this.releaseOwnership();
    }

    resume(): void {
        if (this.disposed) return;
        if (voiceSettings.pauseOnBusy && this.busy) {
            this.state.notice = '执行中，语音已暂歇；本轮结束后自动恢复。';
            this.wantEnabled = true;
            return;
        }
        this.manualPaused = false;
        this.wantEnabled = true;
        void this.enable();
    }

    toggle(): void {
        if (this.machine.phase === 'error') {
            this.dispatch({ type: 'dismiss-error' });
            void this.enable();
            return;
        }
        if (this.machine.phase === 'paused' || this.machine.phase === 'off') {
            this.resume();
            return;
        }
        if (this.isActive()) {
            this.pause('manual');
        }
    }

    disable(): void {
        this.wantEnabled = false;
        this.manualPaused = false;
        this.autoStartArmed = false;
        this.removeAutoStart?.();
        this.removeAutoStart = null;
        this.stopEngine();
        this.cancelCountdown();
        this.clearIdlePause();
        this.releaseOwnership();
        saveVoiceSettings({ enabled: false });
        this.dispatch({ type: 'disable' });
        this.state.notice = '语音输入已关闭';
    }

    /** run 执行状态：busy=true 暂停，结束后自动恢复。 */
    setBusy(busy: boolean): void {
        const next = Boolean(busy);
        if (this.busy === next) return;
        this.busy = next;
        if (next && voiceSettings.pauseOnBusy && this.isActive() && !this.manualPaused) {
            this.pause('busy');
            this.lastBusyPause = true;
            return;
        }
        if (
            !next &&
            this.lastBusyPause &&
            this.machine.phase === 'paused' &&
            this.machine.pauseReason === 'busy' &&
            this.wantEnabled &&
            !this.manualPaused
        ) {
            this.lastBusyPause = false;
            void this.enable();
        }
    }

    /* ------------------------------ browse consent ------------------------- */

    /** 用户点击“同意并启用浏览器识别”。 */
    grantBrowserConsent(): void {
        saveVoiceSettings({ browserConsent: true });
        this.state.browserConsentRequired = false;
        this.manualPaused = false;
        this.wantEnabled = true;
        void this.enable();
    }

    declineBrowserConsent(): void {
        this.state.browserConsentRequired = false;
        this.wantEnabled = false;
        saveVoiceSettings({ browserConsent: false });
        this.state.notice =
            '已取消浏览器识别；本机模型会在服务启动后自动安装，也可继续用文字输入。';
    }

    /* ---------------------------- tab coordination ------------------------- */

    private setupChannel(): void {
        if (this.channel || typeof BroadcastChannel === 'undefined') return;
        try {
            this.channel = new BroadcastChannel('mazi.voice');
            this.channel.onmessage = (event: MessageEvent) => {
                this.handleChannelMessage(event.data as Record<string, unknown>);
            };
        } catch {
            this.channel = null;
        }
    }

    private handleChannelMessage(data: Record<string, unknown> | null): void {
        if (!data || typeof data.type !== 'string' || data.tabId === this.tabId) return;
        switch (data.type) {
            case 'request': {
                if (this.isActive()) {
                    this.channel?.postMessage({
                        type: 'busy',
                        tabId: data.tabId,
                        owner: this.tabId,
                    });
                }
                break;
            }
            case 'busy': {
                this.pendingOwnership?.(false);
                this.pendingOwnership = null;
                this.state.tabConflict = true;
                break;
            }
            case 'claim': {
                if (this.isActive() && this.machine.phase !== 'paused') {
                    this.pause('other-tab');
                    this.state.notice = '另一标签页接管了语音输入。';
                }
                break;
            }
            case 'takeover': {
                if (this.isActive()) {
                    this.pause('other-tab');
                    this.state.notice = '另一标签页接管了语音输入。';
                }
                this.state.tabConflict = false;
                break;
            }
            case 'release': {
                if (this.state.tabConflict) {
                    this.state.tabConflict = false;
                    this.state.notice = '';
                }
                break;
            }
            default:
                break;
        }
    }

    /** 请求标签页独占；后到标签显示只读提示，可 takeOver() 接管。 */
    private requestOwnership(): Promise<boolean> {
        if (!this.channel || this.forceOwnership) {
            this.forceOwnership = false;
            return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
            let settled = false;
            const finish = (granted: boolean) => {
                if (settled) return;
                settled = true;
                if (this.ownershipTimer) {
                    clearTimeout(this.ownershipTimer);
                    this.ownershipTimer = null;
                }
                this.pendingOwnership = null;
                if (granted) this.channel?.postMessage({ type: 'claim', tabId: this.tabId });
                resolve(granted);
            };
            this.pendingOwnership = finish;
            this.ownershipTimer = this.addTimer(() => finish(true), OWNERSHIP_TIMEOUT_MS);
            this.channel?.postMessage({ type: 'request', tabId: this.tabId, at: this.now() });
        });
    }

    takeOver(): void {
        this.state.tabConflict = false;
        this.state.notice = '';
        this.forceOwnership = true;
        this.manualPaused = false;
        this.wantEnabled = true;
        this.channel?.postMessage({ type: 'takeover', tabId: this.tabId });
        void this.enable();
    }

    private releaseOwnership(): void {
        this.pendingOwnership?.(false);
        this.pendingOwnership = null;
        if (this.ownershipTimer) {
            clearTimeout(this.ownershipTimer);
            this.ownershipTimer = null;
        }
        this.channel?.postMessage({ type: 'release', tabId: this.tabId });
    }

    /* ------------------------------- busy/idle ----------------------------- */

    private scheduleIdlePause(): void {
        this.clearIdlePause();
        const idleMs = voiceSettings.pauseAfterIdleMs;
        if (!idleMs || idleMs <= 0 || !this.isActive()) return;
        this.idleTimer = this.addTimer(() => {
            this.idleTimer = null;
            if (this.isActive()) this.pause('idle');
        }, idleMs);
    }

    private clearIdlePause(): void {
        if (this.idleTimer) {
            this.clearTimer(this.idleTimer);
            this.idleTimer = null;
        }
    }

    /* ---------------------------- default auto start ----------------------- */

    /**
     * 「默认开启实时监听」：enabled=true 时在首次用户手势后尝试自动开麦。
     * - 只尝试一次；不注册任何会自动申请权限的定时器/钩子；
     * - 若解析为 browser-cloud 且尚未同意，保持 OFF，只展示首次同意卡片（不弹权限）。
     */
    private armAutoStart(): void {
        this.removeAutoStart?.();
        this.removeAutoStart = null;
        this.autoStartArmed = false;
        if (typeof window === 'undefined' || typeof document === 'undefined') return;
        if (!voiceSettings.enabled || this.disposed) return;
        if (this.machine.phase !== 'off') return;
        this.wantEnabled = true;
        this.autoStartArmed = true;

        const onGesture = (event: Event) => {
            // 点麦克风按钮本身由 toggle() 在用户手势里处理；快捷键由 toggle 处理。
            const target = event.target as Element | null;
            if (target?.closest?.('.voice-btn, [data-voice-toggle]')) return;
            if (
                event instanceof KeyboardEvent &&
                matchesVoiceShortcut(event, voiceSettings.shortcut)
            ) {
                return;
            }
            this.removeAutoStart?.();
            this.removeAutoStart = null;
            void this.tryAutoStart();
        };
        window.addEventListener('pointerdown', onGesture, { passive: true, capture: true });
        window.addEventListener('touchstart', onGesture, { passive: true, capture: true });
        window.addEventListener('keydown', onGesture, { capture: true });
        this.removeAutoStart = () => {
            window.removeEventListener('pointerdown', onGesture, true);
            window.removeEventListener('touchstart', onGesture, true);
            window.removeEventListener('keydown', onGesture, true);
        };
    }

    private async tryAutoStart(): Promise<void> {
        if (!this.autoStartArmed) return;
        this.autoStartArmed = false;
        this.wantEnabled = true;
        if (!voiceSettings.enabled || this.disposed) return;
        if (this.machine.phase !== 'off' || this.manualPaused || this.busy) return;
        const { engine } = this.resolveEngine();
        if (engine === 'none') {
            if (this.state.modelStatus === 'downloading') {
                this.state.notice = '本机语音模型正在自动安装，请稍候；完成后点麦克风即可。';
                this.scheduleCapsPoll();
            }
            return;
        }
        if (engine === 'browser-cloud' && !voiceSettings.browserConsent) {
            // 只展示首次同意卡片；不自动申请任何权限。
            this.state.browserConsentRequired = true;
            this.state.notice = '浏览器识别可能上传音频，需确认后才能启用。';
            return;
        }
        await this.enable();
    }

    /* ------------------------------- visibility ---------------------------- */

    private installGlobalListeners(): void {
        if (typeof window === 'undefined' || typeof document === 'undefined') return;
        if (this.removeGlobalListeners) return;

        const onVisibility = () => this.handleVisibilityChange();
        const onBlur = () => {
            if (this.machine.phase === 'requesting') return;
            if (this.blurTimer) clearTimeout(this.blurTimer);
            this.blurTimer = this.addTimer(() => {
                this.blurTimer = null;
                if (typeof document !== 'undefined' && document.hasFocus()) return;
                if (!voiceSettings.pauseOnBlur) return;
                if (this.isActive()) this.pause('blur');
            }, 350);
        };
        const onFocus = () => this.handleFocusRestore();
        const onKeydown = (event: KeyboardEvent) => {
            if (matchesVoiceShortcut(event, voiceSettings.shortcut)) {
                event.preventDefault();
                this.toggle();
            }
        };
        document.addEventListener('visibilitychange', onVisibility);
        window.addEventListener('blur', onBlur);
        window.addEventListener('focus', onFocus);
        window.addEventListener('keydown', onKeydown);
        this.removeGlobalListeners = () => {
            document.removeEventListener('visibilitychange', onVisibility);
            window.removeEventListener('blur', onBlur);
            window.removeEventListener('focus', onFocus);
            window.removeEventListener('keydown', onKeydown);
        };
    }

    private handleVisibilityChange(): void {
        if (typeof document === 'undefined') return;
        if (document.hidden) {
            if (voiceSettings.pauseOnBlur && this.isActive()) this.pause('blur');
            return;
        }
        this.handleFocusRestore();
    }

    private handleFocusRestore(): void {
        if (!voiceSettings.pauseOnBlur) return;
        if (this.manualPaused || !this.wantEnabled) return;
        if (this.machine.phase !== 'paused' || this.machine.pauseReason !== 'blur') return;
        this.state.notice = '';
        this.autoResume = true;
        void this.enable().finally(() => {
            this.autoResume = false;
        });
    }

    /* -------------------------------- models ------------------------------- */

    async installModel(modelId?: string): Promise<void> {
        if (this.state.installing) return;
        const id =
            modelId ||
            this.state.capabilities?.models?.find((model) => model.recommended)?.id ||
            this.state.modelId ||
            '';
        if (!id) {
            this.state.downloadError = '未找到可安装的本机语音模型。';
            return;
        }
        this.state.installing = true;
        this.state.modelStatus = 'downloading';
        this.state.downloadProgress = 0;
        this.state.downloadError = '';
        const token = ++this.downloadToken;
        try {
            const { jobId } = await startVoiceModelDownload(id);
            await this.watchDownload(jobId, token);
        } catch (error) {
            if (token !== this.downloadToken) return;
            this.state.installing = false;
            this.state.modelStatus = 'error';
            this.state.downloadError = toVoiceErrorInfo(error).message || '语音包下载失败';
        }
    }

    private async watchDownload(jobId: string, token: number): Promise<void> {
        for (let attempt = 0; attempt < 900; attempt += 1) {
            await this.sleep(DOWNLOAD_POLL_MS);
            if (this.disposed || token !== this.downloadToken) return;
            const status = await fetchVoiceModelDownload(jobId);
            if (this.disposed || token !== this.downloadToken) return;
            const progress = Number(status.progress) || 0;
            this.state.downloadProgress = progress > 1 ? Math.min(1, progress / 100) : progress;
            if (status.status === 'done') {
                this.state.installing = false;
                this.state.downloadProgress = 1;
                await this.refreshCapabilities();
                this.state.modelStatus = this.state.modelInstalled ? 'ready' : 'missing';
                this.state.notice = '本机语音模型安装完成。';
                if (
                    this.machine.phase === 'paused' &&
                    this.wantEnabled &&
                    this.machine.pauseReason !== 'manual'
                ) {
                    void this.enable();
                }
                return;
            }
            if (status.status === 'error') {
                this.state.installing = false;
                this.state.modelStatus = 'error';
                this.state.downloadError = status.error || '语音包下载失败，可重试。';
                return;
            }
            if (status.status === 'queued') {
                this.state.installing = true;
            }
        }
        if (token !== this.downloadToken) return;
        this.state.installing = false;
        this.state.modelStatus = 'error';
        this.state.downloadError = '语音包下载超时，可重试。';
    }

    async removeModel(modelId?: string): Promise<void> {
        const id = modelId || this.state.modelId;
        if (!id) return;
        try {
            await deleteVoiceModel(id);
            await this.refreshCapabilities();
            this.state.notice = '本机语音模型已删除。';
        } catch (error) {
            this.state.downloadError = `删除失败：${toVoiceErrorInfo(error).message}`;
        }
    }

    /* ------------------------------ mic test ------------------------------- */

    async testMicrophone(): Promise<void> {
        if (this.state.micTesting) {
            this.stopMicTest();
            return;
        }
        const capture = new AudioCapture();
        this.state.micTesting = true;
        this.state.micTestLevel = 0;
        this.state.notice = '';
        try {
            await capture.start({
                deviceId: voiceSettings.inputDeviceId,
                onFrame: (frame) => {
                    this.state.micTestLevel = frame.level;
                },
                onError: (error) => {
                    this.state.notice = error.message;
                },
            });
            this.captureForTest = capture;
        } catch (error) {
            this.state.micTesting = false;
            this.state.notice = mapCaptureError(error).message;
        }
    }

    private captureForTest: AudioCapture | null = null;

    stopMicTest(): void {
        this.captureForTest?.stop();
        this.captureForTest = null;
        this.state.micTesting = false;
        this.state.micTestLevel = 0;
    }

    /* -------------------------------- internal ----------------------------- */

    private resetUtterance(): void {
        const utterance = this.utterance;
        this.utterance = null;
        if (utterance) utterance.client.cancel();
    }

    private stopEngine(): void {
        this.resetUtterance();
        this.vad?.reset();
        this.vad = null;
        this.capture?.stop();
        this.capture = null;
        this.browser?.stop();
        this.browser = null;
        this.preRoll = [];
        this.state.level = 0;
        this.state.partial = '';
    }

    private fail(error: VoiceErrorInfo): void {
        if (this.disposed) return;
        this.stopEngine();
        this.cancelCountdown();
        this.clearIdlePause();
        this.releaseOwnership();
        this.dispatch({
            type: 'fail',
            code: error.code,
            message: error.message,
            retryable: error.retryable,
        });
        this.state.notice = '';
        if (error.code === 'model_missing') this.state.modelStatus = 'missing';
    }

    private dispatch(event: Parameters<typeof reduceVoiceState>[1]): void {
        this.machine = reduceVoiceState(this.machine, event);
        this.state.phase = this.machine.phase;
        this.state.enabled = this.machine.enabled;
        this.state.engine = this.machine.engine;
        this.state.partial = this.machine.partial;
        this.state.revision = this.machine.revision;
        this.state.lastFinal = this.machine.lastFinal;
        this.state.countdownEndsAt = this.machine.countdownEndsAt;
        this.state.error = this.machine.error;
        this.state.pauseReason = this.machine.pauseReason;
    }

    private now(): number {
        return this.options.now ? this.options.now() : Date.now();
    }

    private addTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
        const timer = setTimeout(() => {
            this.timers.delete(timer);
            fn();
        }, ms);
        this.timers.add(timer);
        return timer;
    }

    private clearTimer(timer: ReturnType<typeof setTimeout>): void {
        clearTimeout(timer);
        this.timers.delete(timer);
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => {
            this.addTimer(resolve, ms);
        });
    }
}

/**
 * `shortcut` 形如 'Mod+Shift+M'：Mod = ⌘（mac）/ Ctrl（其他）。
 * 只在没有输入焦点时切换，避免劫持 textarea 里的输入。
 */
export function matchesVoiceShortcut(event: KeyboardEvent, shortcut: string): boolean {
    if (!shortcut) return false;
    const parts = shortcut
        .split('+')
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean);
    const key = parts[parts.length - 1] ?? '';
    if (!key) return false;
    const wantsMeta = parts.includes('mod') || parts.includes('meta') || parts.includes('cmd');
    const wantsCtrl = parts.includes('ctrl') || parts.includes('control');
    const wantsShift = parts.includes('shift');
    const wantsAlt = parts.includes('alt') || parts.includes('option');
    const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
    const modOk = wantsMeta ? (isMac ? event.metaKey : event.ctrlKey) : !event.metaKey || wantsMeta;
    if (!modOk) return false;
    if (wantsCtrl && !event.ctrlKey && !isMac) return false;
    if (wantsShift !== event.shiftKey) return false;
    if (wantsAlt !== event.altKey) return false;
    const pressed = event.key.toLowerCase();
    return pressed === key || (key.length === 1 && pressed === key);
}
