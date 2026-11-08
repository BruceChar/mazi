import { describe, expect, it } from 'vitest';
import {
    appendTranscript,
    formatPartial,
    meaningfulLength,
    sanitizeTranscript,
    shouldDiscardFinal,
} from '../src/voice/text.ts';

describe('voice text helpers', () => {
    it('appends Chinese without separators', () => {
        expect(appendTranscript('帮我改一下', '这个文件的类型')).toBe('帮我改一下这个文件的类型');
        expect(appendTranscript('', '你好')).toBe('你好');
        expect(appendTranscript('   ', '你好')).toBe('你好');
    });

    it('inserts a space between latin words / digits only', () => {
        expect(appendTranscript('hello', 'world')).toBe('hello world');
        expect(appendTranscript('abc', '123')).toBe('abc 123');
        expect(appendTranscript('hello ', 'world')).toBe('hello world');
        // 中文边界不补空格（设计：中文直接拼接）
        expect(appendTranscript('你好', 'world')).toBe('你好world');
        expect(appendTranscript('hello', '你好')).toBe('helloworld'.slice(0, 0) + 'hello你好');
    });

    it('sanitizes control chars / zero width / extra whitespace', () => {
        expect(sanitizeTranscript('  \u0000你好\u200b  世界  ')).toBe('你好 世界');
        expect(sanitizeTranscript('a\n\n\nb')).toBe('a\nb');
        expect(sanitizeTranscript(null)).toBe('');
        expect(sanitizeTranscript(42)).toBe('');
    });

    it('discards blank, punctuation-only and too-short finals', () => {
        expect(shouldDiscardFinal('')).toBe(true);
        expect(shouldDiscardFinal('   ')).toBe(true);
        expect(shouldDiscardFinal('。，！')).toBe(true);
        expect(shouldDiscardFinal('嗯')).toBe(true);
        expect(shouldDiscardFinal('好的')).toBe(false);
        expect(shouldDiscardFinal('hi')).toBe(false);
        expect(shouldDiscardFinal('好的', 3)).toBe(true);
        expect(shouldDiscardFinal('好的呀', 3)).toBe(false);
    });

    it('counts meaningful characters after stripping punctuation', () => {
        expect(meaningfulLength('你好，世界！')).toBe(4);
        expect(meaningfulLength('  ')).toBe(0);
    });

    it('formats partial as a single ghost line', () => {
        expect(formatPartial(' 帮我\n改一下 ')).toBe('帮我 改一下');
    });
});
