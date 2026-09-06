import { reactive, ref } from 'vue';
import { api, API_BASE } from './api.js';

const THEME_KEY = 'mazi.web.theme';
const LIVE_EVENT_TYPES = [
    'session.started',
    'session.ended',
    'turn.started',
    'turn.ended',
    'step.started',
    'step.ended',
    'llm.request',
    'llm.response',
    'tool.invoke',
    'tool.result',
    'tool.blocked',
    'policy.check',
    'policy.denied',
    'provider.selected',
    'provider.fallback',
    'plan.created',
    'plan.invalid',
    'capacity.assembled',
    'budget.exceeded',
    'user.feedback.captured',
];
const REFRESH_EVENT_TYPES = new Set([
    'step.ended',
    'turn.ended',
    'session.ended',
    'llm.response',
    'budget.exceeded',
    'provider.fallback',
]);

function systemPrefersDark() {
    return (
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches
    );
}

function readInitialTheme() {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(THEME_KEY) : null;
    return saved === 'dark' || saved === 'light' || saved === 'system' ? saved : 'light';
}

function persistTheme(value) {
    if (typeof localStorage !== 'undefined') {
        localStorage.setItem(THEME_KEY, value);
    }
}

export const theme = ref(readInitialTheme());

export function applyTheme(value) {
    const effective = value === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : value;
    document.documentElement.dataset.theme = effective;
}

export function setTheme(value) {
    theme.value = value;
    applyTheme(value);
    persistTheme(value);
}

applyTheme(theme.value);

export const ui = reactive({
    view: 'chat',
    mainTab: 'chat',
    rightOpen: false,
    drawerTab: 'audit',
    auditSub: 'actual',
    audit: null,
    showNew: false,
    sidebar: true,
    eventTypes: 'all',
    err: null,
});

const USER_PREFERENCES_KEY = 'mazi.web.user-preferences';

function readUserPreferences() {
    try {
        return {
            displayName: localStorage.getItem(`${USER_PREFERENCES_KEY}.displayName`) || 'me',
            favoriteTools: localStorage.getItem(`${USER_PREFERENCES_KEY}.favoriteTools`) || '',
            codeStyle: localStorage.getItem(`${USER_PREFERENCES_KEY}.codeStyle`) || '简洁优先，必要时注释',
            responseStyle: localStorage.getItem(`${USER_PREFERENCES_KEY}.responseStyle`) || '直接、结构化、给出下一步',
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

export const userPreferences = reactive(readUserPreferences());

export function saveUserPreferences(next) {
    Object.assign(userPreferences, next);
    if (typeof localStorage !== 'undefined') {
        for (const [key, value] of Object.entries(userPreferences)) {
            localStorage.setItem(`${USER_PREFERENCES_KEY}.${key}`, String(value));
        }
    }
}

export const conversations = ref([]);
export const current = ref(null);
export const currentConversation = ref(null);
export const detail = ref(null);
export const cfg = ref(null);
export const workspaceRoot = ref('');
export const projects = ref([]);
export const busy = ref(false);
export const metrics = reactive({
    turns: 0,
    steps: 0,
    tokens: 0,
    cost: 0,
    budget: null,
    llmMs: 0,
    ttftSum: 0,
    toolCalls: 0,
    model: '-',
    provider: '-',
});
export const events = reactive({ list: [], types: 'all' });

export const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));

export const short = (s, n = 120) =>
    s && s.length > n ? `${s.slice(0, n)}…` : s || '';

export const icon = (kind) => {
    if (kind === 'thinking') return 'thinking';
    if (kind === 'tool_call') return 'tool';
    if (kind === 'observation') return 'observation';
    return 'userMessage';
};

export const stepLabel = (kind) => {
    if (kind === 'thinking') return '思考';
    if (kind === 'tool_call') return '工具调用';
    if (kind === 'observation') return '上下文/观察';
    return kind || 'step';
};

export const badge = (outcome) => {
    if (outcome === 'success') return 'success';
    if (outcome) return 'failed';
    return 'other';
};

export function fmtUsd(value) {
    const n = Number(value ?? 0);
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 6,
    }).format(n);
}

export function fmtTokens(value) {
    const n = Number(value ?? 0);
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return String(n);
}

export function fmtDuration(ms) {
    const n = Number(ms ?? 0);
    if (!n) return '0s';
    if (n < 1000) return `${Math.round(n)}ms`;
    if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
    const m = Math.floor(n / 60_000);
    const s = Math.round((n % 60_000) / 1000);
    return `${m}分${s}秒`;
}

export function fmtClock(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function relTime(ts) {
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

export async function loadConfig() {
    try {
        cfg.value = await api('/api/config');
        ui.err = null;
    } catch (error) {
        cfg.value = null;
        ui.err = String(error);
    }
}

export async function loadConversations() {
    try {
        conversations.value = await api('/api/conversations');
        ui.err = null;
    } catch (error) {
        ui.err = String(error);
    }
}

export async function loadWorkspace() {
    try {
        const state = await api('/api/workspaces/current');
        workspaceRoot.value = state.path || '';
        projects.value = state.projects || [];
    } catch {
        workspaceRoot.value = '';
    }
}

export async function selectWorkspace(path) {
    if (!path?.trim()) return;
    const state = await api('/api/workspaces/current', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
    });
    workspaceRoot.value = state.path || '';
    await loadWorkspace();
}

export async function pickWorkspace() {
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

let eventSource = null;
let refreshTimer = null;

function refreshLater(sessionId) {
    if (refreshTimer) {
        clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void refreshDetail(sessionId);
    }, 250);
}

async function refreshDetail(sessionId) {
    try {
        detail.value = await api(`/api/sessions/${sessionId}/timeline`);
        recompute();
        await loadConversations();
    } catch {
        // 会话被清理或后端临时不可用时保留旧快照
    }
}

export function stopEvents() {
    if (eventSource) {
        eventSource.close();
        eventSource = null;
    }
    if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
    }
}

export function watchEvents(sessionId) {
    stopEvents();
    if (typeof EventSource === 'undefined') {
        return;
    }
    const source = new EventSource(
        `${API_BASE}/api/events/${encodeURIComponent(sessionId)}?follow=1`,
    );
    const consume = (raw) => {
        try {
            const event = JSON.parse(raw.data);
            if (!events.list.some((e) => e.eventId === event.eventId)) {
                events.list.push(event);
            }
            if (REFRESH_EVENT_TYPES.has(event.type)) {
                refreshLater(sessionId);
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

export async function loadEvents(sessionId) {
    try {
        events.list = await api(`/api/events/${sessionId}?limit=5000`);
    } catch {
        events.list = [];
    }
}

export async function select(sessionId) {
    current.value = sessionId;
    watchEvents(sessionId);
    await Promise.all([loadDetail(sessionId), loadEvents(sessionId)]);
}

export async function openSession(sessionId) {
    await select(sessionId);
    ui.view = 'chat';
}

async function loadDetail(sessionId) {
    try {
        detail.value = await api(`/api/sessions/${sessionId}/timeline`);
        recompute();
        ui.err = null;
    } catch (error) {
        detail.value = null;
        ui.err = String(error);
    }
}

export function recompute() {
    const d = detail.value;
    if (!d) return;
    let steps = 0;
    let tokens = 0;
    let cost = 0;
    let llmMs = 0;
    let ttftSum = 0;
    let toolCalls = 0;
    for (const turn of d.turns || []) {
        for (const step of turn.steps || []) {
            steps += 1;
            if (step.kind === 'tool_call') {
                toolCalls += 1;
            }
            const usage = step.usage;
            if (usage) {
                tokens += (usage.vendor?.inputTokens || 0) + (usage.vendor?.outputTokens || 0);
                cost += usage.cost?.totalCostUsd || 0;
                llmMs += usage.timing?.totalMs || 0;
                ttftSum += usage.timing?.ttftMs || 0;
            }
        }
    }
    const firstCapacity = (d.turns || []).map((t) => t.capacity).filter(Boolean)[0];
    metrics.turns = (d.turns || []).length;
    metrics.steps = steps;
    metrics.tokens = tokens;
    metrics.cost = cost;
    metrics.budget = d.goal?.budget?.maxCostUsd ?? null;
    metrics.llmMs = llmMs;
    metrics.ttftSum = ttftSum;
    metrics.toolCalls = toolCalls;
    metrics.model = firstCapacity?.model?.modelId || '-';
    metrics.provider = firstCapacity?.model?.providerId || '-';
}

export async function createAndRun(exec, goalOverrides, workspacePath) {
    const text = goalOverrides?.statement?.trim() || '';
    if (!text) return null;
    busy.value = true;
    ui.err = null;
    try {
        const goal = goalOverrides
            ? {
                  permissionCeiling: goalOverrides.permissionCeiling,
                  maxCostUsd: goalOverrides.maxCostUsd || undefined,
                  maxSteps: goalOverrides.maxSteps || undefined,
              }
            : undefined;
        const created = await api('/api/sessions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                input: text,
                userId: goalOverrides?.userId,
                goal,
                workspacePath,
            }),
        });
        await loadConversations();
        await select(created.sessionId);
        if (exec) {
            await runCurrent(created.sessionId);
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

export async function runCurrent(sessionId) {
    if (!sessionId) return;
    busy.value = true;
    ui.err = null;
    try {
        await api(`/api/sessions/${sessionId}/run`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
        });
        await loadConversations();
        await select(sessionId);
    } catch (error) {
        ui.err = String(error);
    } finally {
        busy.value = false;
    }
}

export async function updateConversation(conversationId, changes) {
    await api(`/api/conversations/${conversationId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(changes),
    });
    await loadConversations();
}

export async function deleteConversationById(conversationId) {
    if (currentConversation.value === conversationId) {
        current.value = null;
        currentConversation.value = null;
        detail.value = null;
        stopEvents();
    }
    await api(`/api/conversations/${conversationId}`, { method: 'DELETE' });
    await loadConversations();
}

export async function renameProject(path, title) {
    const state = await api('/api/workspaces/project', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, title }),
    });
    if (Array.isArray(state.projects)) {
        projects.value = state.projects;
    }
}

export async function sendFeedback(sessionId, rating, content) {
    await api(`/api/sessions/${sessionId}/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'output_rating', rating, content }),
    });
}

export async function loadProfile(userId) {
    try {
        return await api(`/api/users/${encodeURIComponent(userId)}/profile`);
    } catch {
        return null;
    }
}
