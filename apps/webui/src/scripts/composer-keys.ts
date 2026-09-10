/**
 * Composer key handling (pure logic; see docs/webui.md §3.5).
 * Enter during IME composition confirms a candidate and must not submit;
 * Safari emits compositionend before the confirming keydown, hence the grace window.
 */

/** Grace period after compositionend (ms) covering Safari end-before-keydown ordering. */
export const IME_ENTER_GRACE_MS = 80;

export interface EnterKeyState {
    /** KeyboardEvent.key */
    key: string;
    /** KeyboardEvent.shiftKey */
    shiftKey: boolean;
    /** KeyboardEvent.isComposing: true while composition is active. */
    isComposing?: boolean;
    /** KeyboardEvent.keyCode: legacy browsers report 229 during composition. */
    keyCode?: number;
    /** Local flag set between compositionstart and compositionend. */
    composing?: boolean;
    /** Timestamp of the most recent compositionend (0 when never composed). */
    compositionEndedAt?: number;
    /** Current timestamp; injectable for tests. */
    now?: number;
}

/** True only for a plain Enter outside composition (Shift+Enter stays a newline). */
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
