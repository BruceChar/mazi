import type { VoiceInstallStatus, VoiceModelInfo } from '@mazi/libs';

/** SenseVoice + Silero VAD 的实际文件路径。 */
export interface SenseVoicePaths {
    model: string;
    tokens: string;
    vad: string;
}

/** 模型管理接口（生产实现见 sensevoice-store.ts）。 */
export interface SenseVoiceModelStore {
    installed(): boolean;
    paths(): SenseVoicePaths | null;
    modelInfo(): VoiceModelInfo;
    installStatus(): VoiceInstallStatus | undefined;
    ensureInstalled(): Promise<VoiceInstallStatus>;
    close(): void;
}

export interface SenseVoiceAvailability {
    available: boolean;
    reason?: string;
}

export interface SenseVoiceTranscribeInput {
    /** PCM16LE / mono / 16kHz，不含 WAV 头。 */
    pcm: Uint8Array;
    sampleRate: number;
    language: string;
}

export interface SenseVoiceTranscribeResult {
    text: string;
    inferenceMs: number;
}

/** 整段离线转写宿主（生产实现见 sensevoice-host.ts）。 */
export interface SenseVoiceHost {
    availability(): SenseVoiceAvailability;
    transcribe(input: SenseVoiceTranscribeInput): Promise<SenseVoiceTranscribeResult>;
    closeAll(): void;
}
