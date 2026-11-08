/**
 * 当前 tab 的页面位置持久化：刷新后回到刷新前的页面（尤其是项目 Wiki），
 * 不再被 onMounted 的「打开第一个会话」悄悄带回对话页。
 *
 * 使用 sessionStorage 而非 localStorage：页面位置是 tab 级瞬时状态，
 * 两个 tab 分别停留在对话 / Wiki 时刷新不会互相串页。
 */
import type { UiState } from './store.js';

export type AppView = UiState['view'];

export interface PersistedViewState {
    view: AppView;
    /** 进入项目 Wiki 时锁定的工作区，刷新后据此恢复同一项目的 wiki。 */
    wikiWorkspace: string;
}

const VIEW_STATE_KEY = 'mazi.web.view-state';
const VIEWS: readonly AppView[] = [
    'chat',
    'system-settings',
    'user-center',
    'wiki',
    'evals',
    'lab',
];

function isAppView(value: unknown): value is AppView {
    return typeof value === 'string' && (VIEWS as readonly string[]).includes(value);
}

/** 解析持久化记录；任何损坏 / 未知视图都回退 null（调用方停留在默认页）。 */
export function parseViewState(raw: string | null | undefined): PersistedViewState | null {
    const text = (raw ?? '').trim();
    if (text.length === 0) return null;
    try {
        const data: unknown = JSON.parse(text);
        if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
        const record = data as Record<string, unknown>;
        if (!isAppView(record.view)) return null;
        return {
            view: record.view,
            wikiWorkspace:
                typeof record.wikiWorkspace === 'string' ? record.wikiWorkspace.trim() : '',
        };
    } catch {
        return null;
    }
}

export function serializeViewState(state: PersistedViewState): string {
    return JSON.stringify({ view: state.view, wikiWorkspace: state.wikiWorkspace.trim() });
}

export function readViewState(): PersistedViewState | null {
    try {
        return parseViewState(sessionStorage.getItem(VIEW_STATE_KEY));
    } catch {
        return null;
    }
}

export function saveViewState(state: PersistedViewState): void {
    try {
        sessionStorage.setItem(VIEW_STATE_KEY, serializeViewState(state));
    } catch {
        // sessionStorage 不可用（隐私模式）时只是失去刷新恢复能力。
    }
}

/** 测试用：存储键名。 */
export function viewStateStorageKey(): string {
    return VIEW_STATE_KEY;
}
