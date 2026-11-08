/**
 * 语音输入前端类型（docs/web/语音输入设计.md）。
 *
 * 协议类型从 `@mazi/libs` 导入，前端只关心 UI / 控制器状态；不复制契约字段。
 */
import type {
    VoiceApiError,
    VoiceCapabilities,
    VoiceChunkResponse,
    VoiceInstallStatus,
    VoiceLimits,
    VoiceModelInfo,
} from '@mazi/libs';

export type {
    VoiceApiError,
    VoiceCapabilities,
    VoiceChunkResponse,
    VoiceInstallStatus,
    VoiceLimits,
    VoiceModelInfo,
};

/** 监听模式：continuous 为默认连续监听；push-to-talk 预留。 */
export type VoiceMode = 'continuous' | 'push-to-talk';

/** 用户偏好的引擎；auto 由控制器按 local → browser-on-device → browser-cloud 解析。 */
export type VoiceEnginePreference = 'auto' | 'local' | 'browser-on-device';

/** 实际运行的引擎（browser-on-device / browser-cloud 均为浏览器 Web Speech）。 */
export type VoiceRuntimeEngine = 'local' | 'browser-on-device' | 'browser-cloud' | 'none';

/** 状态机阶段，与设计文档 §5.2 一致。 */
export type VoicePhase =
    | 'off'
    | 'requesting'
    | 'armed'
    | 'capturing'
    | 'partial'
    | 'finalizing'
    | 'committed'
    | 'paused'
    | 'error';

export type VoiceSensitivity = 'low' | 'normal' | 'high';

export type VoicePauseReason =
    | 'manual'
    | 'busy'
    | 'blur'
    | 'idle'
    | 'other-tab'
    | 'consent'
    | 'model'
    | 'gesture';

export interface VoiceErrorInfo {
    code?: string;
    message: string;
    retryable?: boolean;
}

/** localStorage `mazi.web.voice-settings` 的前端偏好。 */
export interface VoiceSettings {
    /** 持久化版本，用于迁移。 */
    version: number;
    /** 默认 true；未授权前不会自动弹权限。 */
    enabled: boolean;
    mode: VoiceMode;
    engine: VoiceEnginePreference;
    language: string;
    /** final 后是否自动发送（默认 true，1.5s 倒计时可取消）。 */
    autoSend: boolean;
    sendDelayMs: number;
    endpointSilenceMs: number;
    sensitivity: VoiceSensitivity;
    maxUtteranceMs: number;
    pauseOnBlur: boolean;
    pauseOnBusy: boolean;
    /** 无语音输入的空闲暂停；0 表示关闭。 */
    pauseAfterIdleMs: number;
    showPartial: boolean;
    /** 浏览器识别（Web Speech）首次使用必须显式同意；默认 false。 */
    browserConsent: boolean;
    /** 快捷键，用于展示与提示（Mod = ⌘/Ctrl）。 */
    shortcut: string;
    inputDeviceId?: string;
}

/** 纯 reducer 状态（可单测，不含 DOM）。 */
export interface VoiceState {
    phase: VoicePhase;
    enabled: boolean;
    engine: VoiceRuntimeEngine | null;
    partial: string;
    /** 当前 utterance partial 的单调版本，用于丢弃乱序。 */
    revision: number;
    lastFinal: string;
    countdownEndsAt: number | null;
    error: VoiceErrorInfo | null;
    pauseReason: VoicePauseReason | null;
}

/** 控制器对外暴露的完整状态（VoiceBar / 设置页诊断读取）。 */
export interface VoiceControllerState extends VoiceState {
    /** secure context 且存在 mediaDevices。 */
    supported: boolean;
    insecureContext: boolean;
    browserSupported: boolean;
    browserOnDevice: boolean;
    browserConsentRequired: boolean;
    capabilities: VoiceCapabilities | null;
    capabilitiesError: string;
    modelId: string | null;
    modelInstalled: boolean;
    modelStatus: 'unknown' | 'ready' | 'missing' | 'downloading' | 'error';
    downloadProgress: number;
    downloadError: string;
    installing: boolean;
    /** 当前麦克风电平 0..1（用于波形）。 */
    level: number;
    /** 非错误提示（没听清 / 另一标签页 / 已暂停等）。 */
    notice: string;
    tabConflict: boolean;
    micTesting: boolean;
    micTestLevel: number;
    enginePreference: VoiceEnginePreference;
}

/** 控制器依赖注入；ChatMain 负责把 Composer/提交回调接进来。 */
export interface VoiceControllerOptions {
    /** final 文本写入 Composer（ChatMain → emit('update:prompt')）。 */
    setPrompt: (text: string) => void;
    /** 自动发送；ChatMain 在 nextTick 后 emit('submit')。 */
    submit: () => void;
    /** 是否可提交（busy 时禁止）。 */
    canSubmit?: () => boolean;
    now?: () => number;
    /** 测试用：覆盖自动发送延迟。 */
    sendDelayMs?: number;
    /** 测试用：覆盖空闲暂停延迟。 */
    idleTimeoutMs?: number;
}

/** 状态机事件（纯数据，可单测）。 */
export type VoiceEvent =
    | { type: 'enable' }
    | { type: 'ready'; engine: VoiceRuntimeEngine }
    | { type: 'fail'; code?: string; message: string; retryable?: boolean }
    | { type: 'vad-start' }
    | { type: 'partial'; text: string; revision?: number }
    | { type: 'endpoint' }
    | { type: 'final'; text: string }
    | { type: 'countdown'; endsAt: number }
    | { type: 'countdown-cancel' }
    | { type: 'pause'; reason: VoicePauseReason }
    | { type: 'resume' }
    | { type: 'disable' }
    | { type: 'user-input' }
    | { type: 'dismiss-error' }
    | { type: 'reset' };
