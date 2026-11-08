/**
 * 麦克风采集：getUserMedia → AudioWorklet → 16kHz PCM16 100ms 帧 + RMS 电平。
 *
 * - mono / echoCancellation / noiseSuppression / autoGainControl；
 * - AudioContext 若非 16kHz，Worklet 内部线性重采样到 16kHz（见 public/voice-capture.worklet.js）；
 * - 错误映射为可读中文（NotAllowedError / NotFoundError / NotReadableError 等）。
 */
import type { VoiceErrorInfo } from './types.ts';

export interface PcmFrame {
    /** PCM16LE / mono / 16kHz，100ms = 1600 samples = 3200 bytes。 */
    pcm: Int16Array;
    /** 帧内 RMS 电平 0..1，用于 VAD / 波形。 */
    level: number;
    /** 采集时间（performance.now() 基准，ms）。 */
    at: number;
}

export interface AudioCaptureOptions {
    deviceId?: string;
    onFrame?: (frame: PcmFrame) => void;
    onError?: (error: VoiceErrorInfo) => void;
    /** 默认 /voice-capture.worklet.js（Vite public 目录）。 */
    workletUrl?: string;
    /** 目标采样率，默认 16000。 */
    sampleRate?: number;
    /** 帧长，默认 100ms。 */
    frameMs?: number;
}

type AudioContextCtor = typeof AudioContext;

function getAudioContextCtor(): AudioContextCtor | null {
    if (typeof window === 'undefined') return null;
    const scope = window as unknown as {
        AudioContext?: AudioContextCtor;
        webkitAudioContext?: AudioContextCtor;
    };
    return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/** secure context + mediaDevices 是否可用（用于 UI 降级判断）。 */
export function isCaptureSupported(): boolean {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
    if (typeof window.isSecureContext === 'boolean' && !window.isSecureContext) return false;
    return Boolean(navigator.mediaDevices?.getUserMedia) && Boolean(getAudioContextCtor());
}

export function mapCaptureError(error: unknown): VoiceErrorInfo {
    const name = error instanceof DOMException ? error.name : '';
    switch (name) {
        case 'NotAllowedError':
        case 'SecurityError':
            return {
                code: 'forbidden',
                message: '麦克风被拒绝。请点地址栏麦克风图标重新允许。',
                retryable: false,
            };
        case 'NotFoundError':
        case 'OverconstrainedError':
            return {
                code: 'engine_unavailable',
                message: '没有检测到麦克风，请连接麦克风后重试。',
                retryable: true,
            };
        case 'NotReadableError':
        case 'AbortError':
            return {
                code: 'engine_unavailable',
                message: '麦克风被其他应用占用，请关闭后重试。',
                retryable: true,
            };
        default:
            return {
                code: 'engine_unavailable',
                message: error instanceof Error ? error.message : String(error),
                retryable: true,
            };
    }
}

export class AudioCapture {
    private stream: MediaStream | null = null;
    private context: AudioContext | null = null;
    private source: MediaStreamAudioSourceNode | null = null;
    private node: AudioWorkletNode | null = null;
    private sink: GainNode | null = null;
    private running = false;

    get active(): boolean {
        return this.running;
    }

    get sampleRate(): number {
        return this.context?.sampleRate ?? 0;
    }

    async start(options: AudioCaptureOptions = {}): Promise<void> {
        if (this.running) return;
        if (!navigator.mediaDevices?.getUserMedia) {
            throw new Error('当前环境不支持麦克风采集（需要 HTTPS 或 localhost）');
        }
        const targetRate = options.sampleRate ?? 16_000;
        const frameMs = options.frameMs ?? 100;
        const frameSamples = Math.round((targetRate * frameMs) / 1000);
        const deviceId =
            options.deviceId && options.deviceId !== 'default' ? options.deviceId : null;

        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
            },
            video: false,
        });
        this.stream = stream;

        const Ctor = getAudioContextCtor();
        if (!Ctor) {
            this.releaseStream();
            throw new Error('当前浏览器不支持 AudioContext');
        }

        let context: AudioContext;
        try {
            context = new Ctor({ sampleRate: targetRate });
        } catch {
            context = new Ctor();
        }
        this.context = context;
        if (!context.audioWorklet) {
            await this.dispose();
            throw new Error('当前浏览器不支持 AudioWorklet，无法进行语音采集');
        }

        const workletUrl =
            options.workletUrl ?? `${import.meta.env.BASE_URL ?? '/'}voice-capture.worklet.js`;
        await context.audioWorklet.addModule(workletUrl);

        const source = context.createMediaStreamSource(stream);
        this.source = source;
        const node = new AudioWorkletNode(context, 'voice-capture', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            processorOptions: {
                inputSampleRate: context.sampleRate,
                targetSampleRate: targetRate,
                frameSamples,
            },
        });
        this.node = node;
        node.port.onmessage = (event: MessageEvent) => {
            const data = event.data as
                | { type: 'ready' }
                | { type: 'audio'; pcm: ArrayBuffer; level: number; at?: number }
                | { type: 'error'; message?: string };
            if (!data || data.type === 'ready') return;
            if (data.type === 'error') {
                options.onError?.({
                    code: 'engine_unavailable',
                    message: data.message ?? '音频采集失败',
                    retryable: true,
                });
                return;
            }
            if (data.type === 'audio') {
                const pcm = new Int16Array(data.pcm);
                options.onFrame?.({
                    pcm,
                    level: Number.isFinite(data.level) ? data.level : 0,
                    at: data.at ?? performance.now(),
                });
            }
        };

        // 零增益下沉节点：保持音频图运行，但不产生回声。
        const sink = context.createGain();
        sink.gain.value = 0;
        this.sink = sink;
        source.connect(node);
        node.connect(sink);
        sink.connect(context.destination);
        await context.resume();
        this.running = true;
    }

    stop(): void {
        this.running = false;
        if (this.node) {
            try {
                this.node.port.onmessage = null;
                this.node.disconnect();
            } catch {
                // Already disconnected.
            }
            this.node = null;
        }
        if (this.source) {
            try {
                this.source.disconnect();
            } catch {
                // Already disconnected.
            }
            this.source = null;
        }
        if (this.sink) {
            try {
                this.sink.disconnect();
            } catch {
                // Already disconnected.
            }
            this.sink = null;
        }
        this.releaseStream();
        const context = this.context;
        this.context = null;
        if (context) {
            void context.close().catch(() => undefined);
        }
    }

    async dispose(): Promise<void> {
        this.stop();
    }

    private releaseStream(): void {
        if (!this.stream) return;
        for (const track of this.stream.getTracks()) {
            try {
                track.stop();
            } catch {
                // Ignore.
            }
        }
        this.stream = null;
    }
}
