import { computed, reactive, ref, watch } from 'vue';
import { API_BASE, api } from '../api.js';
import type {
    ConfigOverview,
    Conversation,
    EventItem,
    GoalTreeSnapshot,
    Project,
    RunOutcome,
    StepUsage,
    UserPreferences,
} from '../types.js';
import { activeStream, applyStreamEvent, type LiveStream, type LiveStreamMap } from './stream.js';

const THEME_KEY = 'mazi.web.theme';
/** Goal/session lifecycle plus step streaming events (step.ended pushes thinking/tool/observation live). */
const LIVE_EVENT_TYPES = [
    'session.started',
    'session.ended',
    'goal.started',
    'goal.ended',
    'user.feedback.captured',
    'step.started',
    'step.ended',
    'llm.stream_event',
    'approval.requested',
    'approval.granted',
    'approval.cancelled',
] as const;
const REFRESH_EVENT_TYPES = new Set<string>(['session.ended', 'goal.ended']);

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
    sidebar: boolean;
    eventTypes: string;
    err: string | null;
}

export const ui = reactive<UiState>({
    view: 'chat',
    rightOpen: false,
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

/** Conversation list (conversations.json); each entry carries its Goal runs[]. */
export const conversations = ref<Conversation[]>([]);
export const cfg = ref<ConfigOverview | null>(null);
export const workspaceRoot = ref<string>('');
/** 随心聊（未选项目）默认工作区；后端配置，用于标题展示与设置。 */
export const freeChatWorkspace = ref<string>('');

/**
 * Effective permission for the current context, resolved by the backend scope
 * maps: `conversation:<id>` override → `workspace:<path>` override → system
 * default. The two scopes are independent and persisted in settings.json
 * (server-authoritative; no client-side seed).
 */
export const sessionPermission = ref<string>('read-only');

function effectiveWorkspaceKey(): string {
    // Match the backend resolution (targetContext.workspace → selected → free):
    // the active conversation's workspace wins, else the selected workspace.
    const active = conversations.value.find((c) => c.conversationId === currentConversation.value);
    return active?.workspace || workspaceRoot.value || '__free__';
}

export function refreshSessionPermission(): void {
    const permissions = cfg.value?.permissions ?? {};
    const conversationKey = currentConversation.value
        ? `conversation:${currentConversation.value}`
        : undefined;
    const workspaceKey = `workspace:${effectiveWorkspaceKey()}`;
    sessionPermission.value =
        (conversationKey ? permissions[conversationKey] : undefined) ??
        permissions[workspaceKey] ??
        cfg.value?.permissionCeiling ??
        'read-only';
}

/**
 * 输入框选择器：写入当前**会话**（有活动会话时）或当前**工作区**（项目/随心聊）
 * 的独立覆盖。不改系统默认，也不影响其他会话/工作区。
 */
export async function setSessionPermission(value: string): Promise<void> {
    sessionPermission.value = value;
    const conversationId = currentConversation.value;
    try {
        cfg.value = await api('/api/permissions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(
                conversationId
                    ? { scope: 'conversation', key: conversationId, permissionCeiling: value }
                    : {
                          scope: 'workspace',
                          key: effectiveWorkspaceKey(),
                          permissionCeiling: value,
                      },
            ),
        });
        ui.err = null;
    } catch (error) {
        // 写入失败（如后端未就绪）不要留下「全局改了」的假象：回退到解析值。
        ui.err = String(error);
        refreshSessionPermission();
    }
}
export const projects = ref<Project[]>([]);
export const busy = ref<boolean>(false);
/** Currently open Goal run (rootGoalId). */
export const current = ref<string | null>(null);
export const currentConversation = ref<string | null>(null);
// 切换会话 → 重新解析该会话的权限（会话覆盖 → 工作区覆盖 → 系统默认），
// 因此一个会话/项目的设置不会串到其他会话/项目。
watch(currentConversation, () => refreshSessionPermission());
/** Goal-tree snapshot of the current run (GET /api/sessions/:id/timeline). */
export const detail = ref<GoalTreeSnapshot | null>(null);
/** Per-run timeline cache (rootGoalId -> snapshot) for displaying old runs */
export const runDetails = reactive<Record<string, GoalTreeSnapshot | null>>({});
/** In-memory run outcomes (POST /run task summary; never persisted). */
export const runOutcomes = reactive<Record<string, RunOutcome>>({});
export const events = reactive<{ list: EventItem[]; types: string }>({ list: [], types: 'all' });

/** 系统日志（GET /api/logs）：服务端错误/告警/信息，供「日志 / 事件」面板查看。 */
export interface SystemLogEntry {
    ts: number;
    level: 'debug' | 'info' | 'warn' | 'error';
    module: string;
    message: string;
}
export const systemLogs = ref<SystemLogEntry[]>([]);

export async function loadSystemLogs(level = 'all', limit = 500): Promise<void> {
    try {
        const state = await api(
            `/api/logs?level=${encodeURIComponent(level)}&limit=${String(limit)}`,
        );
        systemLogs.value = Array.isArray(state?.logs) ? (state.logs as SystemLogEntry[]) : [];
    } catch {
        systemLogs.value = [];
    }
}
/** Active streaming answers (token level); keyed by streamId (docs/web/流式响应设计.md §5). */
export const liveStreams = ref<LiveStreamMap>({});
/** Most recent active stream of the current run (max updatedAt). */
export const activeLiveStream = computed<LiveStream | null>(() => activeStream(liveStreams.value));

/**
 * One step of an executing run, derived from live SSE events. The chat renders
 * these as an append-only list so it never has to swap a whole tree per tick.
 */
export interface LiveStep {
    stepId: string;
    taskId: string;
    kind: string;
    toolName: string;
    /** Short one-line summary (the rendered title). */
    title: string;
    /** Full step content; reserved for expansion. */
    content: string;
    status: string;
    startedAt: number;
    endedAt: number | null;
    /** Vendor/runtime/cost/timing of the round this step belongs to (may be null while running). */
    usage: StepUsage | null;
}

/** Live steps per run (rootGoalId -> ordered steps). */
export const liveSteps = reactive<Record<string, LiveStep[]>>({});

/**
 * Audit panel selection (docs/web/观测看板设计.md §3). Clicking a Step/Task in
 * the chat flow sets these; the right panel resolves them against the run
 * snapshot (and live steps while executing).
 */
export const selectedStepId = ref<string>('');
export const selectedTaskId = ref<string>('');

/** Select a Step (opening the audit panel); taskId keeps sibling context. */
export function selectStep(stepId: string, taskId?: string): void {
    selectedStepId.value = stepId;
    selectedTaskId.value = taskId ?? '';
    ui.rightOpen = true;
}

/** Select a Task (aggregates its steps); opening the audit panel. */
export function selectTask(taskId: string): void {
    selectedStepId.value = '';
    selectedTaskId.value = taskId;
    ui.rightOpen = true;
}

/** Drop the current audit target (run/session switch). */
export function clearAuditSelection(): void {
    selectedStepId.value = '';
    selectedTaskId.value = '';
}

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
    refreshSessionPermission();
}

/** 写入系统级权限 grant（POST /api/config/goal；Settings → General）并刷新配置。 */
export async function setPermissionCeiling(value: string): Promise<void> {
    try {
        cfg.value = await api('/api/config/goal', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ permissionCeiling: value }),
        });
        ui.err = null;
        refreshSessionPermission();
    } catch (error) {
        ui.err = String(error);
    }
}

/** 设置某厂商（vendor）官方价目页地址（POST /api/config/pricing）。 */
export async function setPricingSource(vendor: string, url: string): Promise<void> {
    try {
        cfg.value = await api('/api/config/pricing', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ vendor, sourceUrl: url }),
        });
        ui.err = null;
    } catch (error) {
        ui.err = String(error);
    }
}

/** 立即抓取并应用官网价目（POST /api/config/pricing/refresh；缺省全部厂商）。 */
export async function refreshPricing(vendor?: string): Promise<void> {
    try {
        cfg.value = await api('/api/config/pricing/refresh', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(vendor ? { vendor } : {}),
        });
        ui.err = null;
    } catch (error) {
        ui.err = String(error);
    }
}

/** 从服务端重新同步模型目录（POST /api/config/sync）并刷新配置。 */
export async function syncConfig(): Promise<void> {
    try {
        cfg.value = await api('/api/config/sync', { method: 'POST' });
        ui.err = null;
    } catch (error) {
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
        freeChatWorkspace.value = state.freeChatPath || '';
    } catch {
        workspaceRoot.value = '';
    }
    refreshSessionPermission();
}

/** 保存「随心聊」默认工作区（空 → 后端回退 $MAZI_HOME/workspace）。 */
export async function saveFreeChatWorkspace(path: string): Promise<string> {
    const state = await api('/api/workspaces/free-chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: path?.trim() || '' }),
    });
    freeChatWorkspace.value = state.path || '';
    await loadWorkspace();
    return state.path;
}

/** 系统目录选择器选「随心聊」默认工作区。 */
export async function pickFreeChatWorkspace(): Promise<string | undefined> {
    const state = await api('/api/workspaces/pick-free-chat', { method: 'POST' });
    if (state?.path) {
        freeChatWorkspace.value = state.path;
        await loadWorkspace();
    }
    return state?.path;
}

export async function selectWorkspace(path: string): Promise<void> {
    // An empty path clears the selection (backend maps it to "no workspace").
    const state = await api('/api/workspaces/current', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: path?.trim() || '' }),
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

/** Delete a workspace project config only; conversations are detached and kept. */
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

/** Latest Goal run of a conversation (by createdAt). */
export function latestRun(conversation: Conversation | null | undefined) {
    const runs = conversation?.runs || [];
    return runs.length > 0 ? runs[runs.length - 1] : null;
}

/** 待人审的 gated 调用（approval.requested 累积，granted/cancelled 移除）。 */
export interface PendingApproval {
    invocationId: string;
    tool: string;
    capability: string;
    summary: string;
    identifiers?: { rootGoalId?: string };
    requestedAt?: number;
}

export const approvals = ref<PendingApproval[]>([]);

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
        const snapshot = await api(`/api/sessions/${rootGoalId}/timeline`);
        // The chat renders runDetails[rootGoalId]; without this the live step
        // refresh only touched `detail` and steps appeared only after the run ended.
        detail.value = snapshot;
        runDetails[rootGoalId] = snapshot;
    } catch {
        // Keep the previous snapshot when the session is gone or the backend is briefly unavailable.
    }
}

function liveStepOf(event: EventItem, fallbackStatus: string): LiveStep {
    const payload = (event.payload || {}) as Record<string, unknown>;
    const content = typeof payload.content === 'string' ? payload.content : '';
    const status = typeof payload.status === 'string' ? payload.status : fallbackStatus;
    const at = typeof event.timestamp === 'number' ? event.timestamp : Date.now();
    return {
        stepId: String(event.stepId ?? ''),
        taskId: String(event.taskId ?? ''),
        kind: String(payload.kind ?? 'step'),
        toolName: typeof payload.toolName === 'string' ? payload.toolName : '',
        title: content.replace(/\s+/g, ' ').trim().slice(0, 80),
        content,
        status,
        startedAt: at,
        endedAt: status === 'running' ? null : at,
        usage: (payload.usage as StepUsage | undefined) ?? null,
    };
}

/** step.started: append a row and close any step still marked running. */
function applyStepStarted(rootGoalId: string, event: EventItem): void {
    let list = liveSteps[rootGoalId];
    if (!list) {
        list = [];
        liveSteps[rootGoalId] = list;
    }
    const at = typeof event.timestamp === 'number' ? event.timestamp : Date.now();
    for (const step of list) {
        if (step.status === 'running') {
            step.status = 'ok';
            step.endedAt = at;
        }
    }
    list.push(liveStepOf(event, 'running'));
}

/** step.ended: update the matching row in place (tool call running -> ok/error). */
function applyStepEnded(rootGoalId: string, event: EventItem): void {
    let list = liveSteps[rootGoalId];
    if (!list) {
        list = [];
        liveSteps[rootGoalId] = list;
    }
    const updated = liveStepOf(event, 'ok');
    const existing = list.find((step) => step.stepId === updated.stepId);
    if (!existing) {
        list.push(updated);
        return;
    }
    existing.status = updated.status;
    existing.content = updated.content;
    existing.title = updated.title;
    if (updated.toolName) existing.toolName = updated.toolName;
    existing.endedAt = updated.endedAt;
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
    liveStreams.value = {};
    for (const key of Object.keys(liveSteps)) delete liveSteps[key];
    approvals.value = [];
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
            // Token deltas only feed the live stream; they never enter the event log.
            if (event.type === 'llm.stream_event') {
                liveStreams.value = applyStreamEvent(liveStreams.value, event);
                return;
            }
            if (!events.list.some((e) => e.eventId === event.eventId)) {
                events.list.push(event);
            }
            if (event.type === 'approval.requested') {
                const pending = event.payload as PendingApproval | undefined;
                if (
                    pending?.invocationId &&
                    !approvals.value.some((a) => a.invocationId === pending.invocationId)
                ) {
                    approvals.value = [...approvals.value, pending];
                }
                return;
            }
            if (event.type === 'approval.granted' || event.type === 'approval.cancelled') {
                const id = (event.payload as { invocationId?: string } | undefined)?.invocationId;
                if (id) {
                    approvals.value = approvals.value.filter((a) => a.invocationId !== id);
                }
                return;
            }
            if (event.type === 'step.started') {
                applyStepStarted(rootGoalId, event);
                return;
            }
            if (event.type === 'step.ended') {
                // Update in place; keep the streaming text visible so the answer does
                // not blink out between steps. The final tree replaces it on completion.
                applyStepEnded(rootGoalId, event);
                return;
            }
            if (REFRESH_EVENT_TYPES.has(event.type)) {
                refreshLater(rootGoalId);
            }
        } catch {
            // Ignore frames that cannot be parsed.
        }
    };
    for (const type of LIVE_EVENT_TYPES) {
        source.addEventListener(type, consume);
    }
    eventSource = source;
}

/** 结算一条人审审批（允许一次/本会话/拒绝）。 */
export async function respondApproval(
    invocationId: string,
    decision: 'granted' | 'rejected' | 'cancelled',
    scope?: 'once' | 'session' | 'workspace',
): Promise<void> {
    await api(`/api/approvals/${encodeURIComponent(invocationId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision, ...(scope ? { scope } : {}) }),
    });
    approvals.value = approvals.value.filter((a) => a.invocationId !== invocationId);
}

export async function loadEvents(rootGoalId: string): Promise<void> {
    try {
        const list = (await api(`/api/events/${rootGoalId}?limit=5000`)) as EventItem[];
        // Replay excludes token deltas too: they are render-only, not log material.
        events.list = Array.isArray(list)
            ? list.filter((event) => event.type !== 'llm.stream_event')
            : [];
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

/** Open a Goal run: load its timeline snapshot and subscribe to live events. */
export async function openRun(rootGoalId: string): Promise<void> {
    if (!rootGoalId) return;
    clearAuditSelection();
    current.value = rootGoalId;
    watchEvents(rootGoalId);
    await Promise.all([loadDetail(rootGoalId), loadEvents(rootGoalId)]);
}

/** Open a conversation (selects its latest run by default). */
export async function openConversation(conversationId: string): Promise<void> {
    currentConversation.value = conversationId;
    refreshSessionPermission();
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
 * Create a Goal session: POST /api/sessions, then optionally run it right away.
 * Resolves to the rootGoalId.
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
            refreshSessionPermission();
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
    }
}

/** Execute a Goal run (POST /api/sessions/:id/run) and cache its task summary. */
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
