/**
 * 语音输入前端偏好：localStorage `mazi.web.voice-settings`。
 *
 * 读取时与默认值深合并 + 版本迁移；损坏时静默回退默认值（参照 run-settings.ts）。
 * 只存偏好，不存音频 / 转写文本 / 设备标签。
 */
import { reactive } from 'vue';
import type { VoiceEnginePreference, VoiceMode, VoiceSensitivity, VoiceSettings } from './types.ts';

export const VOICE_SETTINGS_STORAGE_KEY = 'mazi.web.voice-settings';
export const VOICE_SETTINGS_VERSION = 1;

/** 存储接口最小子集，便于单测注入。 */
export interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem?(key: string): void;
}

export const VOICE_SETTINGS_DEFAULTS: Readonly<VoiceSettings> = Object.freeze({
    version: VOICE_SETTINGS_VERSION,
    enabled: true,
    mode: 'continuous',
    engine: 'auto',
    language: 'zh-CN',
    autoSend: true,
    sendDelayMs: 1500,
    endpointSilenceMs: 700,
    sensitivity: 'normal',
    maxUtteranceMs: 30_000,
    pauseOnBlur: true,
    pauseOnBusy: true,
    pauseAfterIdleMs: 600_000,
    showPartial: true,
    browserConsent: false,
    shortcut: 'Mod+Shift+M',
    inputDeviceId: 'default',
});

const MODES: readonly VoiceMode[] = ['continuous', 'push-to-talk'];
const ENGINE_PREFERENCES: readonly VoiceEnginePreference[] = ['auto', 'local', 'browser-on-device'];
const SENSITIVITIES: readonly VoiceSensitivity[] = ['low', 'normal', 'high'];
const LANGUAGE_PATTERN = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;

export function defaultVoiceSettings(): VoiceSettings {
    return { ...VOICE_SETTINGS_DEFAULTS };
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.round(value)));
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function pickString(value: unknown, fallback: string, pattern?: RegExp): string {
    if (typeof value !== 'string') return fallback;
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    if (pattern && !pattern.test(trimmed)) return fallback;
    return trimmed;
}

/** 任意（可能损坏 / 旧版）输入 → 完整、已校验的设置。 */
export function normalizeVoiceSettings(raw: unknown): VoiceSettings {
    const defaults = defaultVoiceSettings();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaults;
    const source = raw as Record<string, unknown>;

    // 版本迁移：v0 的 autoSend 是 'silence' | 'manual'，cloudFallbackConsent 改名。
    const version = typeof source.version === 'number' ? source.version : 0;
    let autoSend = source.autoSend;
    if (typeof autoSend === 'string') autoSend = autoSend === 'silence';
    let browserConsent = source.browserConsent;
    if (typeof browserConsent !== 'boolean' && version < VOICE_SETTINGS_VERSION) {
        browserConsent = source.cloudFallbackConsent;
    }

    return {
        version: VOICE_SETTINGS_VERSION,
        enabled: pickBoolean(source.enabled, defaults.enabled),
        mode: MODES.includes(source.mode as VoiceMode) ? (source.mode as VoiceMode) : defaults.mode,
        engine: ENGINE_PREFERENCES.includes(source.engine as VoiceEnginePreference)
            ? (source.engine as VoiceEnginePreference)
            : defaults.engine,
        language: pickString(source.language, defaults.language, LANGUAGE_PATTERN),
        autoSend: pickBoolean(autoSend, defaults.autoSend),
        sendDelayMs: clampNumber(source.sendDelayMs, defaults.sendDelayMs, 0, 10_000),
        endpointSilenceMs: clampNumber(
            source.endpointSilenceMs,
            defaults.endpointSilenceMs,
            200,
            3_000,
        ),
        sensitivity: SENSITIVITIES.includes(source.sensitivity as VoiceSensitivity)
            ? (source.sensitivity as VoiceSensitivity)
            : defaults.sensitivity,
        maxUtteranceMs: clampNumber(source.maxUtteranceMs, defaults.maxUtteranceMs, 1_000, 60_000),
        pauseOnBlur: pickBoolean(source.pauseOnBlur, defaults.pauseOnBlur),
        pauseOnBusy: pickBoolean(source.pauseOnBusy, defaults.pauseOnBusy),
        pauseAfterIdleMs: clampNumber(
            source.pauseAfterIdleMs,
            defaults.pauseAfterIdleMs,
            0,
            3_600_000,
        ),
        showPartial: pickBoolean(source.showPartial, defaults.showPartial),
        browserConsent: pickBoolean(browserConsent, defaults.browserConsent),
        shortcut: pickString(source.shortcut, defaults.shortcut),
        inputDeviceId: pickString(source.inputDeviceId, defaults.inputDeviceId ?? 'default'),
    };
}

/** 读取设置；localStorage 不可用 / JSON 损坏 / 无值均回退默认值，不抛错。 */
export function readVoiceSettings(storage?: StorageLike | null): VoiceSettings {
    const target = storage ?? getStorage();
    if (!target) return defaultVoiceSettings();
    try {
        const raw = target.getItem(VOICE_SETTINGS_STORAGE_KEY);
        if (!raw) return defaultVoiceSettings();
        return normalizeVoiceSettings(JSON.parse(raw));
    } catch {
        return defaultVoiceSettings();
    }
}

/** 写入设置（失败静默：隐私模式 / 配额满时内存态仍生效）。 */
export function writeVoiceSettings(settings: VoiceSettings, storage?: StorageLike | null): void {
    const target = storage ?? getStorage();
    if (!target) return;
    try {
        target.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch {
        // Storage unavailable; in-memory reactive state still wins.
    }
}

function getStorage(): StorageLike | null {
    try {
        if (typeof localStorage === 'undefined') return null;
        return localStorage;
    } catch {
        return null;
    }
}

/** 全局响应式设置；默认 enabled=true，但权限只会在用户手势里请求。 */
export const voiceSettings = reactive<VoiceSettings>(readVoiceSettings());

/** 合并写入并持久化。 */
export function saveVoiceSettings(next: Partial<VoiceSettings>): VoiceSettings {
    const merged = normalizeVoiceSettings({ ...voiceSettings, ...next });
    Object.assign(voiceSettings, merged);
    writeVoiceSettings(merged);
    return merged;
}

/** 恢复默认值（用于设置页“恢复默认”）。 */
export function resetVoiceSettings(): VoiceSettings {
    const defaults = defaultVoiceSettings();
    Object.assign(voiceSettings, defaults);
    writeVoiceSettings(defaults);
    return defaults;
}
