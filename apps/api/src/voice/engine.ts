import type { VoiceApiError } from '@mazi/libs';

/** 打开一次本机识别会话所需的上下文。 */
export interface VoiceEngineOpenOptions {
    sessionId: string;
    modelId: string;
    /** 模型目录（包含 encoder/decoder/joiner/tokens 文件）。 */
    modelDir: string;
    language: string;
    sampleRate: 16000;
}

/** 一个 utterance 的流式识别会话。 */
export interface VoiceEngineSession {
    /** 推送一帧 PCM16LE / mono / 16kHz；返回本轮累计 partial（可空）。 */
    push(pcm: Uint8Array): Promise<{ partial?: string }>;
    /** 结束并返回 final 文本。 */
    end(): Promise<{ text: string }>;
    /** 释放资源（幂等）。 */
    close(): void;
}

/** 引擎可用性。 */
export interface VoiceEngineAvailability {
    available: boolean;
    reason?: string;
}

/** 本机 ASR 引擎宿主；生产实现是子进程，测试实现是内存 fake。 */
export interface VoiceEngineHost {
    availability(): VoiceEngineAvailability;
    open(options: VoiceEngineOpenOptions): Promise<VoiceEngineSession>;
    closeAll(): void;
}

export class VoiceEngineError extends Error {
    readonly code: VoiceApiError['code'];
    readonly retryable: boolean;

    constructor(code: VoiceApiError['code'], message: string, retryable = false) {
        super(message);
        this.name = 'VoiceEngineError';
        this.code = code;
        this.retryable = retryable;
    }
}
