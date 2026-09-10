import { reactive, ref } from 'vue';
import { api, API_BASE } from './api.js';
import type {
    Conversation,
    ConfigOverview,
    EventItem,
    GoalTreeSnapshot,
    Project,
    RunOutcome,
    UserPreferences,
} from './types';

const THEME_KEY = 'mazi.web.theme';
/** Goal 会话事件 + Step 流式事件（step.ended：思考/工具/观察实时推送） */
const LIVE_EVENT_TYPES = [
    'session.started',
    'session.ended',
    'user.feedback.captured',
    'step.ended',
] as const;
const REFRESH_EVENT_TYPES = new Set<string>(['session.ended']);

function systemPrefersDark(): boolean {
    return (
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches
    );
}

function readInitialTheme(): 'dark' | 'light' | 'system' {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(THEME_KEY) : null;
    return saved === 'dark' || saved === 'light' || saved === 'system' ? saved : 'light';
}

function persistTheme(value: string): void {
    if (typeof localStorage !== 'undefined') {
        localStorage.setItem(THEME_KEY, value);
    }
}

export const theme = ref<'dark' | 'light' | 'system'>(readInitialTheme());

export function applyTheme(value: string): void {
    const effective = value === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : value;
    document.documentElement.dataset.theme = effective;
}

export function setTheme(value: 'dark' | 'light' | 'system'): void {
    theme.value = value;
    applyTheme(value);
    persistTheme(value);
}

applyTheme(theme.value);

export interface UiState {
    view: 'chat' | 'system-settings' | 'settings';
    rightOpen: boolean;
    showNew: boolean;
    sidebar: boolean;
    eventTypes: string;
    err: string | null;
}

export const ui = reactive<UiState>({
    view: 'chat',
    rightOpen: false,
    showNew: false,
    sidebar: true,
    eventTypes: 'all',
    err: null,
});

const USER_PREFERENCES_KEY = 'mazi.web.user-preferences';

function readUserPreferences(): UserPreferences {
    try {
        return {
            displayName: localStorage.getItem(`${USER_PREFERENCES_KEY}.displayName`) || 'me',
            favoriteTools: localStorage.getItem(`${USER_PREFERENCES_KEY}.favoriteTools`) || '',
            codeStyle:
                localStorage.getItem(`${USER_PREFERENCES_KEY}.codeStyle`) || '简洁优先，必要时注释',
            responseStyle:
                localStorage.getItem(`${USER_PREFERENCES_KEY}.responseStyle`) ||
                '直接、结构化、给出下一步',
        };
    } catch {
        return {
            displayName: 'me',
            favoriteTools: '',
            codeStyle: '简洁优先，必要时注释',
            responseStyle: '直接、结构化、给出下一步',
        };
    }
}

export const userPreferences = reactive<UserPreferences>(readUserPreferences());

export function saveUserPreferences(next: Partial<UserPreferences>): void {
    Object.assign(userPreferences, next);
    if (typeof localStorage !== 'undefined') {
        for (const [key, value] of Object.entries(userPreferences)) {
            localStorage.setItem(`${USER_PREFERENCES_KEY}.${key}`, String(value));
        }
    }
}

/** 会话列表（conversations.json；每条含 Goal run 引用 runs[]） */
export const conversations = ref<Conversation[]>([]);
export const cfg = ref<ConfigOverview | null>(null);
export const workspaceRoot = ref<string>('');
export const projects = ref<Project[]>([]);
export const busy = ref<boolean>(false);
/** 当前打开的 Goal run（rootGoalId） */
export const current = ref<string | null>(null);
export const currentConversation = ref<string | null>(null);
/** 当前 run 的 Goal 树快照（GET /api/sessions/:id/timeline） */
export const detail = ref<GoalTreeSnapshot | null>(null);
/** Per-run timeline cache (rootGoalId -> snapshot) for displaying old runs */
export const runDetails = reactive<Record<string, GoalTreeSnapshot | null>>({});
/** 本会话内存中的 run 结果（POST run 响应 tasks 摘要；不持久化） */
export const runOutcomes = reactive<Record<string, RunOutcome>>({});
export const events = reactive<{ list: EventItem[]; types: string }>({ list: [], types: 'all' });

export const esc = (s: unknown): string =>
    String(s ?? '').replace(
        /[&<>"']/g,
        (c) =>
            (
                ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }) as Record<
                    string,
                    string
                >
            )[c],
    );

export const short = (s: string | null | undefined, n = 120): string =>
    s && s.length > n ? `${s.slice(0, n)}…` : s || '';

export function statusLabel(status: string | null | undefined): string {
    const map: Record<string, string> = {
        active: '进行中',
        succeeded: '成功',
        failed: '失败',
        aborted: '中止',
        timeout: '超时',
        ok: '成功',
        error: '出错',
        blocked: '拦截',
        running: '运行中',
        pending: '待执行',
        rolled_back: '已回滚',
    };
    return map[status ?? ''] ?? status ?? '—';
}

export function fmtUsd(value: number | string | null | undefined): string {
    const n = Number(value ?? 0);
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 6,
    }).format(n);
}

export function fmtClock(ts: number | null | undefined): string {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (isToday) return time;
    const date = d.toLocaleDateString([], { year: 'numeric', month: '2-digit', day: '2-digit' });
    return `${date} ${time}`;
}

export function relTime(ts: number | null | undefined): string {
    if (!ts) return '';
    const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (seconds < 60) return '刚刚';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} 分钟`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} 小时`;
    const days = Math.round(hours / 24);
    if (days < 30) return `${days} 天`;
    return new Date(ts).toLocaleDateString();
}

export async function loadConfig(): Promise<void> {
    try {
        cfg.value = await api('/api/config');
        ui.err = null;
    } catch (error) {
        cfg.value = null;
        ui.err = String(error);
    }
}

export async function loadConversations(): Promise<void> {
    try {
        conversations.value = await api('/api/conversations');
        ui.err = null;
    } catch (error) {
        ui.err = String(error);
    }
}

export async function loadWorkspace(): Promise<void> {
    try {
        const state = await api('/api/workspaces/current');
        workspaceRoot.value = state.path || '';
        projects.value = state.projects || [];
    } catch {
        workspaceRoot.value = '';
    }
}

export async function selectWorkspace(path: string): Promise<void> {
    if (!path?.trim()) return;
    const state = await api('/api/workspaces/current', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
    });
    workspaceRoot.value = state.path || '';
    await loadWorkspace();
}

export async function pickWorkspace(): Promise<string | undefined> {
    const state = await api('/api/workspaces/pick', { method: 'POST' });
    if (state?.path) {
        workspaceRoot.value = state.path;
        if (Array.isArray(state.projects) && state.projects.length > 0) {
            projects.value = state.projects;
        } else {
            await loadWorkspace();
        }
    }
    return state?.path;
}

export async function renameProject(path: string, title: string): Promise<void> {
    const state = await api('/api/workspaces/project', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, title }),
    });
    if (Array.isArray(state.projects)) {
        projects.value = state.projects;
    }
}

/** 删除工作区项目配置（仅配置；对话记录解除归属后保留） */
export async function deleteWorkspaceProject(path: string): Promise<void> {
    const state = await api('/api/workspaces/project', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
    });
    await Promise.all([loadWorkspace(), loadConversations()]);
    if (Array.isArray(state.projects)) {
        projects.value = state.projects;
    }
}

/** Conversation 最新一条 Goal run（按 createdAt） */
export function latestRun(conversation: Conversation | null | undefined) {
    const runs = conversation?.runs || [];
    return runs.length > 0 ? runs[runs.length - 1] : null;
}

let eventSource: EventSource | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function refreshLater(rootGoalId: string): void {
    if (refreshTimer) {
        clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void refreshDetail(rootGoalId);
    }, 250);
}

async function refreshDetail(rootGoalId: string): Promise<void> {
    try {
        detail.value = await api(`/api/sessions/${rootGoalId}/timeline`);
        await loadConversations();
    } catch {
        // 会话被清理或后端临时不可用时保留旧快照
    }
}

export function stopEvents(): void {
    if (eventSource) {
        eventSource.close();
        eventSource = null;
    }
    if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
    }
}

export function watchEvents(rootGoalId: string): void {
    stopEvents();
    if (typeof EventSource === 'undefined') {
        return;
    }
    const source = new EventSource(
        `${API_BASE}/api/events/${encodeURIComponent(rootGoalId)}?follow=1`,
    );
    const consume = (raw: MessageEvent): void => {
        try {
            const event = JSON.parse(raw.data) as EventItem;
            if (!events.list.some((e) => e.eventId === event.eventId)) {
                events.list.push(event);
            }
            if (REFRESH_EVENT_TYPES.has(event.type)) {
                refreshLater(rootGoalId);
            }
        } catch {
            // 忽略无法解析的帧
        }
    };
    for (const type of LIVE_EVENT_TYPES) {
        source.addEventListener(type, consume);
    }
    eventSource = source;
}

export async function loadEvents(rootGoalId: string): Promise<void> {
    try {
        events.list = await api(`/api/events/${rootGoalId}?limit=5000`);
    } catch {
        events.list = [];
    }
}

async function loadDetail(rootGoalId: string): Promise<void> {
    try {
        detail.value = await api(`/api/sessions/${rootGoalId}/timeline`);
        runDetails[rootGoalId] = detail.value;
        ui.err = null;
    } catch (error) {
        detail.value = null;
        ui.err = String(error);
    }
}

/** Load timeline for a specific run (cached) — for displaying old runs */
export async function loadRunDetail(rootGoalId: string): Promise<void> {
    if (!rootGoalId || runDetails[rootGoalId]) return;
    try {
        runDetails[rootGoalId] = await api(`/api/sessions/${rootGoalId}/timeline`);
    } catch {
        runDetails[rootGoalId] = null;
    }
}

/** 打开一棵 Goal 树（run）：拉取时间线快照并订阅事件 */
export async function openRun(rootGoalId: string): Promise<void> {
    if (!rootGoalId) return;
    current.value = rootGoalId;
    watchEvents(rootGoalId);
    await Promise.all([loadDetail(rootGoalId), loadEvents(rootGoalId)]);
}

/** 打开 Conversation（默认选中最新一条 run） */
export async function openConversation(conversationId: string): Promise<void> {
    currentConversation.value = conversationId;
    const conversation = conversations.value.find((item) => item.conversationId === conversationId);
    const run = latestRun(conversation);
    if (run) {
        await openRun(run.rootGoalId);
    } else {
        current.value = null;
        detail.value = null;
        stopEvents();
    }
}

export interface CreateRunOptions {
    input: string;
    userId?: string;
    workspacePath?: string;
    conversationId?: string;
    exec?: boolean;
    goal?: Record<string, unknown>;
}

/**
 * 新建 Goal 会话：POST /api/sessions（create）→ 可选立即 POST run。
 * returns rootGoalId
 */
export async function createRun({
    input,
    userId,
    workspacePath,
    conversationId,
    exec = true,
    goal,
}: CreateRunOptions): Promise<string | null> {
    const text = String(input ?? '').trim();
    if (!text) return null;
    busy.value = true;
    ui.err = null;
    try {
        const body: Record<string, unknown> = { input: text, userId, workspacePath };
        if (goal && typeof goal === 'object') {
            body.goal = goal;
        }
        if (conversationId) {
            body.conversationId = conversationId;
        }
        const created = await api('/api/sessions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (created.conversationId) {
            currentConversation.value = created.conversationId;
        }
        await loadConversations();
        await openRun(created.sessionId);
        if (exec) {
            await executeRun(created.sessionId);
        }
        return created.sessionId;
    } catch (error) {
        ui.err = String(error);
        return null;
    } finally {
        busy.value = false;
        ui.showNew = false;
    }
}

/** 执行当前 Goal run（POST /api/sessions/:id/run），并把 tasks 摘要记入内存 */
export async function executeRun(rootGoalId: string): Promise<void> {
    if (!rootGoalId) return;
    busy.value = true;
    ui.err = null;
    try {
        const result = await api(`/api/sessions/${rootGoalId}/run`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
        });
        const tasks = Array.isArray(result.tasks) ? result.tasks : [];
        const last = tasks[tasks.length - 1];
        const rejected = Array.isArray(result.rejected) ? result.rejected.join('；') : '';
        runOutcomes[rootGoalId] = {
            ok: Boolean(result.ok),
            finalMessage: last?.finalMessage || '',
            errorMessage: last?.errorMessage || rejected || (result.ok ? '' : '任务失败'),
            reason: last?.reason || (result.ok ? 'final-answer' : ''),
            taskCount: tasks.length,
        };
        await loadConversations();
        await loadDetail(rootGoalId);
    } catch (error) {
        ui.err = String(error);
    } finally {
        busy.value = false;
    }
}

export async function updateConversation(
    conversationId: string,
    changes: Record<string, unknown>,
): Promise<void> {
    await api(`/api/conversations/${conversationId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(changes),
    });
    await loadConversations();
}

export async function deleteConversationById(conversationId: string): Promise<void> {
    if (currentConversation.value === conversationId) {
        current.value = null;
        currentConversation.value = null;
        detail.value = null;
        stopEvents();
    }
    await api(`/api/conversations/${conversationId}`, { method: 'DELETE' });
    await loadConversations();
}

export async function sendFeedback(
    rootGoalId: string,
    rating: string,
    content?: string,
): Promise<void> {
    await api(`/api/sessions/${rootGoalId}/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'output_rating', rating, content }),
    });
}
