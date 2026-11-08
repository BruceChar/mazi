/**
 * 纯能量 VAD（设计 §6.5）：自适应噪声底 + RMS 阈值。
 *
 * - 语音开始：连续 ≥ speechStartMs（默认 150ms）高于阈值；
 * - 端点：静音 ≥ endpointSilenceMs（默认 700ms，可配）；
 * - 最短语音 300ms（过短的 end 带 tooShort，控制器直接丢弃）；
 * - 最长 30s（强制 end，reason = 'max-duration'）。
 *
 * 不依赖 DOM / 定时器：调用方每帧 push(level, now)，返回事件数组；可单测。
 */
import type { VoiceSensitivity } from './types.ts';

export interface VadOptions {
    /** 连续高于阈值多久算语音开始。 */
    speechStartMs: number;
    /** 静音多久判定端点。 */
    endpointSilenceMs: number;
    /** 最短语音时长。 */
    minSpeechMs: number;
    /** 单次 utterance 最长时长。 */
    maxUtteranceMs: number;
    sensitivity: VoiceSensitivity;
}

export type VadEndReason = 'silence' | 'max-duration';

export type VadEvent =
    | { type: 'level'; level: number; noiseFloor: number }
    | { type: 'start'; at: number }
    | {
          type: 'end';
          at: number;
          durationMs: number;
          reason: VadEndReason;
          tooShort: boolean;
      };

export const VAD_DEFAULTS: Readonly<VadOptions> = {
    speechStartMs: 150,
    endpointSilenceMs: 700,
    minSpeechMs: 300,
    maxUtteranceMs: 30_000,
    sensitivity: 'normal',
};

/** 灵敏度 → 相对噪声底的阈值倍数 / 绝对下限（RMS）。 */
const SENSITIVITY: Record<VoiceSensitivity, { factor: number; floor: number }> = {
    low: { factor: 5, floor: 0.012 },
    normal: { factor: 3.5, floor: 0.008 },
    high: { factor: 2.5, floor: 0.005 },
};

const INITIAL_NOISE_FLOOR = 0.004;
/** 噪声底自适应系数：越小越稳定，越大越跟环境。 */
const NOISE_ADAPT = 0.05;

export class EnergyVad {
    private options: VadOptions;
    private noiseFloor = INITIAL_NOISE_FLOOR;
    private speaking = false;
    private aboveSince: number | null = null;
    private speechStartAt = 0;
    private lastAboveAt = 0;
    private lastLevel = 0;

    constructor(options: Partial<VadOptions> = {}) {
        this.options = { ...VAD_DEFAULTS, ...options };
    }

    get speechActive(): boolean {
        return this.speaking;
    }

    get currentNoiseFloor(): number {
        return this.noiseFloor;
    }

    get level(): number {
        return this.lastLevel;
    }

    /** 动态更新设置（静音灵敏度 / 端点时长在设置页改动后即时生效）。 */
    update(options: Partial<VadOptions>): void {
        this.options = { ...this.options, ...options };
    }

    reset(): void {
        this.speaking = false;
        this.aboveSince = null;
        this.speechStartAt = 0;
        this.lastAboveAt = 0;
        this.lastLevel = 0;
    }

    /** 阈值：自适应噪声底 × 灵敏度倍数，带绝对下限。 */
    threshold(): number {
        const { factor, floor } = SENSITIVITY[this.options.sensitivity] ?? SENSITIVITY.normal;
        return Math.max(this.noiseFloor * factor, floor);
    }

    /** 是否认为该帧是语音（高于阈值）。 */
    isSpeechLevel(level: number): boolean {
        return Number.isFinite(level) && level >= this.threshold();
    }

    /**
     * 喂入一帧 RMS 电平（0..1）与时间戳（ms），返回本帧产生的事件。
     * level 事件每帧都有，状态事件只在迁移时出现。
     */
    feed(levelRaw: number, now: number): VadEvent[] {
        const level = Number.isFinite(levelRaw) ? Math.max(0, Math.min(1, levelRaw)) : 0;
        this.lastLevel = level;
        const events: VadEvent[] = [];
        const noisy = this.isSpeechLevel(level);

        if (!this.speaking) {
            // 静音期自适应噪声底（语音帧不参与，避免把说话当噪声）。
            if (!noisy) {
                this.noiseFloor = this.noiseFloor * (1 - NOISE_ADAPT) + level * NOISE_ADAPT;
            }
            if (noisy) {
                if (this.aboveSince == null) this.aboveSince = now;
                if (now - this.aboveSince >= this.options.speechStartMs) {
                    this.speaking = true;
                    this.speechStartAt = this.aboveSince;
                    this.lastAboveAt = now;
                    this.aboveSince = null;
                    events.push({ type: 'start', at: this.speechStartAt });
                }
            } else {
                this.aboveSince = null;
            }
        }

        if (this.speaking) {
            if (noisy) this.lastAboveAt = now;
            const durationMs = now - this.speechStartAt;
            if (durationMs >= this.options.maxUtteranceMs) {
                events.push(this.endEvent(now, 'max-duration'));
            } else if (!noisy && now - this.lastAboveAt >= this.options.endpointSilenceMs) {
                events.push(this.endEvent(now, 'silence'));
            }
        }

        events.push({ type: 'level', level, noiseFloor: this.noiseFloor });
        return events;
    }

    private endEvent(now: number, reason: VadEndReason): VadEvent {
        const durationMs = Math.max(0, now - this.speechStartAt);
        const tooShort = durationMs < this.options.minSpeechMs;
        this.speaking = false;
        this.aboveSince = null;
        this.speechStartAt = 0;
        this.lastAboveAt = 0;
        return { type: 'end', at: now, durationMs, reason, tooShort };
    }
}

/**
 * 归一化 RMS：Worklet 直接给 0..1 的 RMS；这里提供防御性转换，
 * 便于测试/脚本复用。
 */
export function rmsToLevel(rms: number): number {
    if (!Number.isFinite(rms) || rms <= 0) return 0;
    return Math.min(1, rms);
}
