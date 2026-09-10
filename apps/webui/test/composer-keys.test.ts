import { describe, expect, it } from 'vitest';
import { IME_ENTER_GRACE_MS, shouldSubmitOnEnter } from '../src/scripts/composer-keys.ts';

function state(over = {}) {
    return {
        key: 'Enter',
        shiftKey: false,
        isComposing: false,
        keyCode: 13,
        composing: false,
        compositionEndedAt: 0,
        now: 1_000_000,
        ...over,
    };
}

describe('composer Enter 提交判定（输入法安全）', () => {
    it('普通 Enter 提交', () => {
        expect(shouldSubmitOnEnter(state())).toBe(true);
    });

    it('Shift+Enter 不提交（用于换行）', () => {
        expect(shouldSubmitOnEnter(state({ shiftKey: true }))).toBe(false);
    });

    it('非 Enter 键不提交', () => {
        expect(shouldSubmitOnEnter(state({ key: 'a' }))).toBe(false);
    });

    it('输入法组合进行中（isComposing / composing）不提交', () => {
        expect(shouldSubmitOnEnter(state({ isComposing: true }))).toBe(false);
        expect(shouldSubmitOnEnter(state({ composing: true }))).toBe(false);
    });

    it('兼容组合态 keyCode=229 → 不提交', () => {
        expect(shouldSubmitOnEnter(state({ isComposing: false, keyCode: 229 }))).toBe(false);
    });

    it('compositionend 后极短窗口内的回车不提交（Safari 先 end 后 keydown）', () => {
        const end = 1_000_000;
        expect(
            shouldSubmitOnEnter(state({ compositionEndedAt: end, now: end + IME_ENTER_GRACE_MS - 1 })),
        ).toBe(false);
    });

    it('composition 早已结束的回车正常提交', () => {
        const end = 1_000_000;
        expect(
            shouldSubmitOnEnter(state({ compositionEndedAt: end, now: end + IME_ENTER_GRACE_MS })),
        ).toBe(true);
    });
});
