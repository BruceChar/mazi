/**
 * 浏览器 Web Speech API 封装（实验性 / 降级引擎）。
 *
 * - 优先使用 on-device（`SpeechRecognition.available({ processLocally: true })`）；
 * - 云端识别必须由用户显式同意（controller 检查 voiceSettings.browserConsent）；
 * - continuous + interimResults；onend 自动重启（指数退避）；
 * - 错误映射到 VoiceErrorInfo（权限 / 网络 / 语言不支持 / 音频设备）。
 *
 * 注意：不能模拟键盘事件，识别结果只通过回调交给 Controller。
 */
import type { VoiceErrorInfo } from './types.ts';

/** 浏览器实现差异较大，这里只声明用到的子集。 */
export interface WebSpeechAlternative {
    transcript: string;
    confidence: number;
}

export interface WebSpeechResult {
    readonly isFinal: boolean;
    readonly length: number;
    [index: number]: WebSpeechAlternative;
}

export interface WebSpeechResultList {
    readonly length: number;
    [index: number]: WebSpeechResult;
}

export interface WebSpeechResultEvent extends Event {
    readonly resultIndex: number;
    readonly results: WebSpeechResultList;
}

export interface WebSpeechErrorEvent extends Event {
    readonly error: string;
    readonly message?: string;
}

export type WebSpeechAvailabilityStatus =
    | 'available'
    | 'downloadable'
    | 'downloading'
    | 'unavailable'
    | 'unknown';

export interface WebSpeechRecognition {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    maxAlternatives: number;
    processLocally?: boolean;
    onresult: ((event: WebSpeechResultEvent) => void) | null;
    onerror: ((event: WebSpeechErrorEvent) => void) | null;
    onend: ((event: Event) => void) | null;
    onstart: ((event: Event) => void) | null;
    onaudiostart?: ((event: Event) => void) | null;
    onspeechend?: ((event: Event) => void) | null;
    start(): void;
    stop(): void;
    abort(): void;
}

export interface WebSpeechRecognitionConstructor {
    new (): WebSpeechRecognition;
    available?: (options: {
        langs?: string[];
        processLocally?: boolean;
    }) => Promise<WebSpeechAvailabilityStatus>;
}

export interface BrowserAsrDetection {
    supported: boolean;
    /** processLocally + 语言包都可用 → on-device（音频不出本机）。 */
    onDevice: boolean;
    availability: WebSpeechAvailabilityStatus;
    reason?: string;
}

function getConstructor(): WebSpeechRecognitionConstructor | null {
    if (typeof window === 'undefined') return null;
    const scope = window as unknown as {
        SpeechRecognition?: WebSpeechRecognitionConstructor;
        webkitSpeechRecognition?: WebSpeechRecognitionConstructor;
    };
    return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/** 检测 Web Speech 支持与 on-device 能力（不触发麦克风/权限）。 */
export async function detectBrowserAsr(language = 'zh-CN'): Promise<BrowserAsrDetection> {
    const Ctor = getConstructor();
    if (!Ctor) {
        return {
            supported: false,
            onDevice: false,
            availability: 'unavailable',
            reason: '浏览器不支持 Web Speech API',
        };
    }
    if (typeof Ctor.available !== 'function') {
        // 老浏览器没有 available()：可用，但只能按云端识别处理（需用户同意）。
        return { supported: true, onDevice: false, availability: 'unknown' };
    }
    try {
        const status = await Ctor.available({ langs: [language], processLocally: true });
        const onDevice = status === 'available';
        return {
            supported: true,
            onDevice,
            availability: status,
            reason: onDevice ? undefined : '本机语音语言包不可用',
        };
    } catch (error) {
        return {
            supported: true,
            onDevice: false,
            availability: 'unknown',
            reason: error instanceof Error ? error.message : String(error),
        };
    }
}

export function mapSpeechError(errorCode: string): VoiceErrorInfo {
    switch (errorCode) {
        case 'not-allowed':
        case 'service-not-allowed':
            return {
                code: 'forbidden',
                message: '麦克风权限被拒绝。请点地址栏麦克风图标重新允许。',
                retryable: false,
            };
        case 'audio-capture':
            return {
                code: 'engine_unavailable',
                message: '没有检测到麦克风，或麦克风被其他应用占用。',
                retryable: true,
            };
        case 'network':
            return {
                code: 'engine_unavailable',
                message: '浏览器识别网络不可用，请改用文字输入，或安装本机模型。',
                retryable: true,
            };
        case 'language-not-supported':
            return {
                code: 'bad_request',
                message: '浏览器不支持当前识别语言。',
                retryable: false,
            };
        case 'no-speech':
            return { code: 'asr_failed', message: '没听到声音，请再说一次。', retryable: true };
        case 'aborted':
            return { code: 'asr_failed', message: '识别已取消。', retryable: true };
        default:
            return {
                code: 'asr_failed',
                message: `浏览器识别失败：${errorCode}`,
                retryable: true,
            };
    }
}

export interface BrowserAsrClientOptions {
    language?: string;
    /** 是否要求 on-device（true 时设置 processLocally；云端由用户同意后传 false）。 */
    onDevice?: boolean;
    onPartial?: (text: string) => void;
    onFinal?: (text: string) => void;
    onError?: (error: VoiceErrorInfo) => void;
    /** 重启前的最大退避。 */
    maxBackoffMs?: number;
}

const RESTART_BASE_MS = 250;
const RESTART_MAX_MS = 5_000;
const MAX_RESTARTS = 6;

/**
 * 连续识别客户端：start() 后持续监听，自动重启；stop() 释放。
 * 由 Controller 管理生命周期（暂停/失焦时 stop）。
 */
export class BrowserAsrClient {
    private readonly options: BrowserAsrClientOptions;
    private recognition: WebSpeechRecognition | null = null;
    private running = false;
    private restarts = 0;
    private restartTimer: ReturnType<typeof setTimeout> | null = null;
    /** 已 final 的结果段（连续识别会多次 final）。 */
    private finalSegments: string[] = [];
    private restarting = false;

    constructor(options: BrowserAsrClientOptions = {}) {
        this.options = options;
    }

    get active(): boolean {
        return this.running;
    }

    get onDevice(): boolean {
        return this.options.onDevice === true;
    }

    start(): void {
        if (this.running) return;
        const Ctor = getConstructor();
        if (!Ctor) {
            this.options.onError?.({
                code: 'engine_unavailable',
                message: '当前浏览器不支持 Web Speech API。',
                retryable: false,
            });
            return;
        }
        this.running = true;
        this.restarts = 0;
        this.finalSegments = [];
        this.createAndStart(Ctor);
    }

    stop(): void {
        this.running = false;
        this.restarting = false;
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        const recognition = this.recognition;
        this.recognition = null;
        if (recognition) {
            recognition.onresult = null;
            recognition.onerror = null;
            recognition.onend = null;
            recognition.onstart = null;
            try {
                recognition.abort();
            } catch {
                // Already stopped.
            }
        }
    }

    dispose(): void {
        this.stop();
    }

    private createAndStart(Ctor: WebSpeechRecognitionConstructor): void {
        const recognition = new Ctor();
        this.recognition = recognition;
        recognition.lang = this.options.language ?? 'zh-CN';
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;
        if (this.options.onDevice && 'processLocally' in recognition) {
            try {
                recognition.processLocally = true;
            } catch {
                // Older implementations ignore the flag.
            }
        }

        recognition.onresult = (event) => this.handleResult(event);
        recognition.onerror = (event) => this.handleError(event);
        recognition.onend = () => this.handleEnd(Ctor);
        recognition.onstart = () => {
            this.restarts = 0;
            this.restarting = false;
        };

        try {
            recognition.start();
        } catch (error) {
            // start() 同步抛错（通常在已在运行时）：按一次退避重启处理。
            this.options.onError?.({
                code: 'asr_failed',
                message: error instanceof Error ? error.message : '浏览器识别启动失败',
                retryable: true,
            });
            this.handleEnd(Ctor);
        }
    }

    private handleResult(event: WebSpeechResultEvent): void {
        let interim = '';
        let finalText = '';
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
            const result = event.results[i];
            const transcript = result?.[0]?.transcript ?? '';
            if (!transcript) continue;
            if (result.isFinal) {
                finalText += transcript;
                this.finalSegments.push(transcript);
            } else {
                interim += transcript;
            }
        }
        if (finalText) {
            this.restarts = 0;
            this.options.onFinal?.(finalText);
        }
        if (interim) {
            this.options.onPartial?.(interim);
        }
    }

    private handleError(event: WebSpeechErrorEvent): void {
        if (event.error === 'no-speech' || event.error === 'aborted') {
            // no-speech 是正常空闲；aborted 由 stop() 触发，都不上报错误。
            return;
        }
        this.options.onError?.(mapSpeechError(event.error));
        if (event.error === 'not-allowed' || event.error === 'language-not-supported') {
            this.running = false;
        }
    }

    private handleEnd(Ctor: WebSpeechRecognitionConstructor): void {
        if (!this.running) return;
        if (this.restarting) return;
        if (this.restarts >= MAX_RESTARTS) {
            this.running = false;
            this.options.onError?.({
                code: 'asr_failed',
                message: '浏览器识别反复中断，已停止。可点麦克风重试或改用文字输入。',
                retryable: true,
            });
            return;
        }
        const delay = Math.min(
            this.options.maxBackoffMs ?? RESTART_MAX_MS,
            RESTART_BASE_MS * 2 ** this.restarts,
        );
        this.restarts += 1;
        this.restarting = true;
        this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            this.restarting = false;
            if (!this.running) return;
            this.createAndStart(Ctor);
        }, delay);
    }
}
