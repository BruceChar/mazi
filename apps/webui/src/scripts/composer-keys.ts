/**
 * 输入框按键判定（纯逻辑，docs/webui.md §3.5）。
 * 关键点：中文等输入法组合（IME composition）期间的回车属于「确认候选」，
 * 不能当作发送；Safari 会在确认的 keydown 之前先发 compositionend，故额外保留极短宽限窗口。
 */

/** compositionend 后的回车宽限（ms）：覆盖 Safari「先 compositionend 后 keydown」的事件顺序 */
export const IME_ENTER_GRACE_MS = 80;

export interface EnterKeyState {
    /** KeyboardEvent.key */
    key: string;
    /** KeyboardEvent.shiftKey */
    shiftKey: boolean;
    /** KeyboardEvent.isComposing：组合进行中为 true */
    isComposing?: boolean;
    /** KeyboardEvent.keyCode：组合态旧浏览器回传 229 */
    keyCode?: number;
    /** compositionstart 后、compositionend 前的本地标志 */
    composing?: boolean;
    /** 最近一次 compositionend 的时间戳（0 表示未组合过） */
    compositionEndedAt?: number;
    /** 当前时间戳，便于测试注入 */
    now?: number;
}

/** 判断这次按键是否应当触发发送：仅「非组合态、非 Shift 的 Enter」返回 true。 */
export function shouldSubmitOnEnter(state: EnterKeyState): boolean {
    if (state.key !== 'Enter' || state.shiftKey) return false;
    if (state.composing === true) return false;
    if (state.isComposing === true) return false;
    if (state.keyCode === 229) return false;
    const endedAt = state.compositionEndedAt ?? 0;
    const now = state.now ?? Date.now();
    if (endedAt > 0 && now - endedAt < IME_ENTER_GRACE_MS) return false;
    return true;
}
