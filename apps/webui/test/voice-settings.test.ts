import { describe, expect, it } from 'vitest';
import {
    defaultVoiceSettings,
    normalizeVoiceSettings,
    readVoiceSettings,
    VOICE_SETTINGS_DEFAULTS,
    VOICE_SETTINGS_STORAGE_KEY,
    writeVoiceSettings,
} from '../src/voice/settings.ts';

function fakeStorage(initial: Record<string, string> = {}) {
    const map = new Map(Object.entries(initial));
    return {
        getItem(key: string) {
            return map.get(key) ?? null;
        },
        setItem(key: string, value: string) {
            map.set(key, value);
        },
        removeItem(key: string) {
            map.delete(key);
        },
        dump() {
            return Object.fromEntries(map);
        },
    };
}

describe('voice settings', () => {
    it('ships the documented defaults', () => {
        expect(defaultVoiceSettings()).toEqual({
            version: 1,
            enabled: true,
            mode: 'continuous',
            engine: 'auto',
            language: 'zh-CN',
            autoSend: true,
            sendDelayMs: 1500,
            endpointSilenceMs: 700,
            sensitivity: 'normal',
            maxUtteranceMs: 30000,
            pauseOnBlur: true,
            pauseOnBusy: true,
            pauseAfterIdleMs: 600000,
            showPartial: true,
            browserConsent: false,
            shortcut: 'Mod+Shift+M',
            inputDeviceId: 'default',
        });
        expect(VOICE_SETTINGS_DEFAULTS.enabled).toBe(true);
    });

    it('falls back to defaults for missing or corrupted storage', () => {
        expect(readVoiceSettings(fakeStorage())).toEqual(defaultVoiceSettings());
        expect(
            readVoiceSettings(fakeStorage({ [VOICE_SETTINGS_STORAGE_KEY]: '{not json' })),
        ).toEqual(defaultVoiceSettings());
        expect(
            readVoiceSettings(fakeStorage({ [VOICE_SETTINGS_STORAGE_KEY]: 'null' })),
        ).toEqual(defaultVoiceSettings());
        expect(readVoiceSettings(null)).toEqual(defaultVoiceSettings());
    });

    it('deep-merges partial values and ignores unknown fields', () => {
        const normalized = normalizeVoiceSettings({
            enabled: false,
            autoSend: false,
            endpointSilenceMs: 900,
            unknownField: 'ignored',
        });
        expect(normalized.enabled).toBe(false);
        expect(normalized.autoSend).toBe(false);
        expect(normalized.endpointSilenceMs).toBe(900);
        expect(normalized).not.toHaveProperty('unknownField');
        expect(normalized.mode).toBe('continuous');
    });

    it('validate enums and clamps numeric bounds', () => {
        const normalized = normalizeVoiceSettings({
            mode: 'nope',
            engine: 'cloud',
            language: 'not a language!',
            sensitivity: 'extreme',
            sendDelayMs: 999999,
            endpointSilenceMs: 10,
            maxUtteranceMs: 0,
            pauseAfterIdleMs: -5,
        });
        expect(normalized.mode).toBe('continuous');
        expect(normalized.engine).toBe('auto');
        expect(normalized.language).toBe('zh-CN');
        expect(normalized.sensitivity).toBe('normal');
        expect(normalized.sendDelayMs).toBe(10000);
        expect(normalized.endpointSilenceMs).toBe(200);
        expect(normalized.maxUtteranceMs).toBe(1000);
        expect(normalized.pauseAfterIdleMs).toBe(0);
    });

    it('migrates v0 settings (string autoSend + cloudFallbackConsent)', () => {
        const migrated = normalizeVoiceSettings({
            version: 0,
            autoSend: 'silence',
            cloudFallbackConsent: true,
            endpointSilenceMs: 800,
        });
        expect(migrated.version).toBe(1);
        expect(migrated.autoSend).toBe(true);
        expect(migrated.browserConsent).toBe(true);
        expect(migrated.endpointSilenceMs).toBe(800);

        expect(normalizeVoiceSettings({ autoSend: 'manual' }).autoSend).toBe(false);
    });

    it('round-trips through storage', () => {
        const storage = fakeStorage();
        writeVoiceSettings({ ...defaultVoiceSettings(), enabled: false }, storage);
        const stored = storage.dump()[VOICE_SETTINGS_STORAGE_KEY];
        expect(stored).toBeTruthy();
        expect(JSON.parse(stored as string).enabled).toBe(false);
        expect(readVoiceSettings(storage).enabled).toBe(false);
    });

    it('does not throw when storage writes fail', () => {
        const broken = {
            getItem() {
                return null;
            },
            setItem() {
                throw new Error('quota');
            },
        };
        expect(() => writeVoiceSettings(defaultVoiceSettings(), broken)).not.toThrow();
    });
});
