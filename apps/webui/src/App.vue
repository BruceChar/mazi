<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import LineIcon from './assets/LineIcon.vue';
import ConfirmDialog from './components/ConfirmDialog.vue';
import SettingsPage from './components/SettingsPage.vue';
import SettingsSidebar from './components/SettingsSidebar.vue';
import RightPanel from './components/RightPanel.vue';
import Sidebar from './components/Sidebar.vue';
import ChatMain from './components/ChatMain.vue';
import TopBar from './components/TopBar.vue';
import FeedbackModal from './components/FeedbackModal.vue';
import PromptDialog from './components/PromptDialog.vue';
import UserPreferencesPage from './components/UserPreferencesPage.vue';
import { defaultConversations, projectConversations } from './scripts/conversation.ts';
import { goalFromRunSettings, runSettings, saveRunSettings } from './scripts/run-settings.ts';
import { buildAuditView } from './scripts/audit.ts';
import { API_BASE } from './api.js';
import {
    activeLiveStream,
    approvals,
    busy,
    cfg,
    conversations,
    createRun,
    current,
    deleteWorkspaceProject,
    currentConversation,
    deleteConversationById,
    detail,
    runDetails,
    loadRunDetail,
    events,
    liveSteps,
    loadConfig,
    loadConversations,
    loadSystemLogs,
    loadWorkspace,
    systemLogs,
    freeChatWorkspace,
    pickFreeChatWorkspace,
    saveFreeChatWorkspace,
    openRun,
    pickWorkspace,
    projects,
    renameProject,
    respondApproval,
    runOutcomes,
    clearAuditSelection,
    selectStep,
    selectTask,
    selectWorkspace,
    selectedStepId,
    selectedTaskId,
    sendFeedback,
    setPermissionCeiling,
    setTheme,
    short,
    statusLabel,
    stopEvents,
    syncConfig,
    theme,
    ui,
    updateConversation,
    workspaceRoot,
} from './scripts/store.js';

const prompt = ref('');
const q = ref('');
const drawerTab = ref('audit');
const rightWidth = ref(440);
const MIN_PANEL_W = 280;
const MAX_PANEL_W = 960;
const searchOpen = ref(false);
const projectCollapsed = ref(new Set());
const accountOpen = ref(false);
const selectedModel = ref(runSettings.model || '');
const REASONING_LEVELS = [
    { value: 'off', label: 'Off' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
];
const reasoningLevel = ref(runSettings.reasoningLevel || 'high');

/** Persist model / reasoning defaults so every new session uses them. */
function setSelectedModel(value) {
    selectedModel.value = value;
    saveRunSettings({ model: value });
}
/** 审批弹窗回执：{ invocationId, decision, scope? } → POST /api/approvals/:id。 */
function onApprovalResponse(payload) {
    void respondApproval(payload.invocationId, payload.decision, payload.scope);
}

function setReasoningLevel(value) {
    reasoningLevel.value = value;
    saveRunSettings({ reasoningLevel: value });
}
const feedbackSent = ref(false);
const feedbackModal = ref(false);
/** Workspace switch menu visibility. */
const workspaceMenu = ref(false);
/** Suggestion cards shown on the empty welcome screen. */
const suggestionCards = [
    { icon: 'search', title: 'Explore and understand code', color: '#3b82f6', prompt: '帮我探索和理解这个代码库的结构和核心逻辑' },
    { icon: 'hammer', title: 'Build a new feature, app, or tool', color: '#8b5cf6', prompt: '帮我构建一个新功能、应用或工具' },
    { icon: 'refresh', title: 'Review code and suggest changes', color: '#10b981', prompt: '帮我审查代码并提出改进建议' },
    { icon: 'bug', title: 'Fix issues and failures', color: '#f97316', prompt: '帮我定位并修复问题和故障' },
];
/** Display name of the current workspace (last path segment). */
const workspaceDisplayName = computed(() => {
    const p = workspaceRoot.value;
    if (!p) return '';
    const parts = p.replace(/\/+$/, '').split('/');
    return parts[parts.length - 1] || p;
});

async function onSaveFreeChatWorkspace(path) {
    try {
        await saveFreeChatWorkspace(path);
    } catch (error) {
        ui.err = String(error);
    }
}

async function onPickFreeChatWorkspace() {
    try {
        await pickFreeChatWorkspace();
    } catch (error) {
        ui.err = String(error);
    }
}
function useSuggestion(card) {
    prompt.value = card.prompt;
}
/** In-app confirmation dialog (replaces window.confirm). */
const confirmDialog = ref({ open: false, title: '', message: '', confirmText: '确认', danger: false, action: null });
async function runConfirmAction() {
    const d = confirmDialog.value;
    if (d.action) await d.action();
    d.open = false;
    d.action = null;
}
function cancelConfirm() {
    confirmDialog.value.open = false;
    confirmDialog.value.action = null;
}

/** In-app text prompt (replaces window.prompt) used by the rename flows. */
const promptDialog = ref({
    open: false,
    title: '',
    label: '',
    value: '',
    confirmText: '保存',
    action: null,
});
async function confirmPrompt(value) {
    const d = promptDialog.value;
    if (d.action) await d.action(value);
    d.open = false;
    d.action = null;
}
function cancelPrompt() {
    promptDialog.value.open = false;
    promptDialog.value.action = null;
}

const modelOptions = computed(() => {
    const providers = cfg.value?.providers || [];
    return providers.flatMap((p) =>
        (p.models || []).map((m) => ({
            id: m.id,
            label: m.name || m.id,
            providerId: p.id,
        })),
    );
});

watch(
    modelOptions,
    (options) => {
        if (!options.some((option) => option.id === selectedModel.value)) {
            // 优先保留已保存的默认模型；不在列表时回落到第一个
            const saved = runSettings.model;
            selectedModel.value =
                saved && options.some((option) => option.id === saved)
                    ? saved
                    : options[0]?.id || '';
        }
    },
    { immediate: true },
);

function latestRun(conversation) {
    const runs = conversation?.runs || [];
    return runs.length > 0 ? runs[runs.length - 1] : null;
}

const filteredConversations = computed(() => {
    const key = q.value.trim().toLowerCase();
    if (!key) {
        return conversations.value;
    }
    return conversations.value.filter((conversation) => {
        const title = String(conversation.title || '').toLowerCase().includes(key);
        const runHit = (conversation.runs || []).some((run) =>
            String(run.input || '').toLowerCase().includes(key),
        );
        return title || runHit;
    });
});

const activeConvList = computed(() =>
    filteredConversations.value.filter((c) => c.archived !== true),
);
const generalConversations = computed(() => defaultConversations(activeConvList.value));
const activeConversation = computed(() =>
    conversations.value.find((c) => c.conversationId === currentConversation.value),
);

/** 顶部栏会话名称：最多 12 个字符，超出以省略号截断。 */
const headerTitle = computed(() => {
    const title = conversationTitle(activeConversation.value) || '';
    return title.length > 12 ? title.slice(0, 12) + '…' : title;
});
/**
 * 顶部栏会话工作区。
 * 项目会话用会话自身记录的 `workspace`（即当前项目工作空间），
 * 随心聊才回退到已选工作区 / 随心聊默认工作区。
 */
const headerWorkspace = computed(
    () =>
        activeConversation.value?.workspace || workspaceRoot.value || freeChatWorkspace.value,
);
const runs = computed(() => activeConversation.value?.runs || []);

/** Lazy-load timeline for every run in the active conversation */
watch(
    () => runs.value,
    (runList) => {
        for (const run of runList || []) {
            loadRunDetail(run.rootGoalId);
        }
    },
    { immediate: true },
);
/** Live steps of the executing run (drives the status bar while running). */
const currentLiveSteps = computed(() => (current.value ? liveSteps[current.value] || [] : []));
const taskCount = computed(() => {
    if (busy.value && currentLiveSteps.value.length > 0) {
        return new Set(currentLiveSteps.value.map((step) => step.taskId)).size;
    }
    return detail.value?.taskCount ?? 0;
});
const stepCount = computed(() => {
    if (busy.value && currentLiveSteps.value.length > 0) return currentLiveSteps.value.length;
    return detail.value?.stepCount ?? 0;
});
const rootOutcome = computed(() => (current.value ? runOutcomes[current.value] : null));

/**
 * Right-panel audit view of the selected Step/Task (docs/web/观测看板设计.md).
 * Resolves the target against the run snapshot, falling back to the live
 * append-only steps while the run is still executing.
 */
/** 当前 Conversation 的全部 run（按时间顺序）+ 快照。 */
const conversationRuns = computed(() =>
    runs.value.map((run) => ({
        rootGoalId: run.rootGoalId,
        input: run.input || '',
        snapshot: runDetails[run.rootGoalId] ?? null,
    })),
);
const auditSnapshot = computed(() =>
    current.value ? (runDetails[current.value] ?? detail.value ?? null) : (detail.value ?? null),
);
const auditLiveSteps = computed(() => (current.value ? liveSteps[current.value] || [] : []));

const auditView = computed(() =>
    buildAuditView({
        runs: conversationRuns.value,
        snapshot: auditSnapshot.value,
        liveSteps: auditLiveSteps.value,
        stepId: selectedStepId.value,
        taskId: selectedTaskId.value,
        conversationTitle: conversationTitle(activeConversation.value),
    }),
);

/** 会话总览（不随 Step/Task 选择变化）。 */
const conversationAudit = computed(() =>
    buildAuditView({
        runs: conversationRuns.value,
        snapshot: auditSnapshot.value,
        liveSteps: auditLiveSteps.value,
        conversationTitle: conversationTitle(activeConversation.value),
    }),
);

/** Conversation-wide totals for the status bar under the composer. */
const conversationStats = computed(() => {
    let goals = 0;
    let tasks = 0;
    let steps = 0;
    for (const run of runs.value) {
        const snapshot = runDetails[run.rootGoalId];
        if (!snapshot) continue;
        for (const goal of snapshot.goals || []) {
            const goalTasks = goal.tasks || [];
            if (goalTasks.length === 0) continue;
            goals += 1;
            tasks += goalTasks.length;
            for (const task of goalTasks) {
                steps += (task.steps || []).filter(
                    (step) => step.kind !== 'intent' && step.kind !== 'observation',
                ).length;
            }
        }
    }
    const usage = conversationAudit.value.usage;
    return {
        sessions: runs.value.length,
        goals,
        tasks,
        steps,
        inputTokens: usage.vendor?.input ?? 0,
        outputTokens: usage.vendor?.output ?? 0,
        costUsd: usage.cost?.total ?? 0,
    };
});

const syncingModels = ref(false);
async function syncModels() {
    syncingModels.value = true;
    try {
        await syncConfig();
    } finally {
        syncingModels.value = false;
    }
}

function onSelectStep(target) {
    if (!target?.stepId) return;
    selectStep(target.stepId, target.taskId);
    drawerTab.value = 'audit';
}

/** 右侧面板（审计/Context）点击 step：选中并滚动主对话流到该 step。 */
function scrollToStep(stepId) {
    if (typeof document === 'undefined') return;
    const el = document.querySelector('[data-step-id="' + stepId + '"]');
    if (el instanceof HTMLElement) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
}

async function onLocateStep(target) {
    if (!target?.stepId) return;
    selectStep(target.stepId, target.taskId);
    // Context 面板内定位时停留在 Context（keepTab），审计/步骤明细则切到审计。
    if (!target.keepTab) drawerTab.value = 'audit';
    await nextTick();
    scrollToStep(target.stepId);
}

function onSelectTask(taskId) {
    if (!taskId) return;
    selectTask(taskId);
    drawerTab.value = 'audit';
}

/** 「会话汇总」：清空 Step/Task 选择，展示整条 Conversation（与点击会话列表一致）。 */
function onSelectConversation() {
    clearAuditSelection();
    drawerTab.value = 'audit';
}

/** Whether the right panel is maximized over the workspace. */
const panelMaximized = ref(false);
const settingsTab = ref('general');
const SETTINGS_TABS = [
    { id: 'general', label: 'General', icon: 'settings' },
    { id: 'model', label: 'Model', icon: 'cpu' },
    { id: 'providers', label: 'Providers', icon: 'plug' },
    { id: 'about', label: 'About', icon: 'info' },
];
function togglePanelMax() {
    panelMaximized.value = !panelMaximized.value;
}

function conversationTitle(conversation) {
    const run = latestRun(conversation);
    return conversation?.title || run?.input || '';
}

/** Reset the open conversation back to the blank welcome screen. */
function resetConversation() {
    currentConversation.value = null;
    current.value = null;
    detail.value = null;
    stopEvents();
}

/**
 * Top "新会话": drop the cached workspace selection, then open the blank screen,
 * so the next conversation starts workspace-less ("随心聊").
 */
async function startTopConversation() {
    try {
        await selectWorkspace('');
    } catch (error) {
        ui.err = String(error);
    }
    resetConversation();
}

/**
 * Project "+": select that project's workspace so the composer shows it, then
 * open the blank screen. The run is created on submit with that workspace.
 */
async function startProjectConversation(project) {
    try {
        await selectWorkspace(project.path);
    } catch (error) {
        ui.err = String(error);
        return;
    }
    resetConversation();
}

function toggleProject(path) {
    const s = new Set(projectCollapsed.value);
    s.has(path) ? s.delete(path) : s.add(path);
    projectCollapsed.value = s;
}

function kindLabel(kind) {
    if (kind === 'thinking') return 'thinking';
    if (kind === 'intent') return 'intent';
    if (kind === 'tool_call') return 'tool';
    return kind || '-';
}

/** Step stream: pair step.started/step.ended, derive duration and expose structured usage. */
const stepEventRows = computed(() => {
    const startedAt = new Map();
    for (const ev of events.list) {
        if (ev.type === 'step.started' && ev.stepId) {
            startedAt.set(ev.stepId, ev.timestamp ?? 0);
        }
    }
    const rows = [];
    for (const ev of events.list) {
        if (ev.type !== 'step.ended' || !ev.stepId) continue;
        const p = ev.payload || {};
        if (p.kind === 'observation') continue; // observation is the tool output, redundant
        const start = startedAt.get(ev.stepId);
        const end = ev.timestamp ?? 0;
        const durationMs = start ? end - start : null;
        rows.push({
            key: 'ev-' + ev.eventId,
            stepId: ev.stepId,
            goalId: p.goalId || '',
            taskId: p.taskId || '',
            at: end,
            time: fmtClockMs(end),
            kind: p.kind || 'step',
            kindLabel: kindLabel(p.kind),
            status: p.status || 'ok',
            statusLabel: statusLabel(p.status || 'ok'),
            id: short(ev.stepId, 34),
            toolName: p.toolName || '',
            text: p.output ? String(p.output) : p.content ? String(p.content) : '',
            durationMs,
            duration: durationMs != null ? formatDuration(durationMs) : '',
            usage: p.usage || null,
            usageText: formatUsage(p.usage),
        });
    }
    rows.sort((a, b) => a.at - b.at);
    return rows;
});

/** Timestamp formatter with milliseconds (HH:MM:SS.mmm). */
function fmtClockMs(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
    if (d.toDateString() === now.toDateString()) return time;
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return `${date} ${time}`;
}

function formatDuration(ms) {
    if (ms == null) return '';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

/** Human-readable summary of vendor + runtime token usage. */
function formatUsage(usage) {
    if (!usage) return '';
    const parts = [];
    if (usage.vendor) {
        const v = usage.vendor;
        parts.push(`vendor in ${v.inputTokens} / out ${v.outputTokens}`);
        if (v.cacheReadInputTokens) parts.push(`cache ${v.cacheReadInputTokens}`);
        if (v.reasoningOutputTokens) parts.push(`reasoning ${v.reasoningOutputTokens}`);
    }
    if (usage.runtime) {
        const r = usage.runtime;
        parts.push(
            `ctx ${r.totalContextTokens} (sys ${r.systemPromptTokens}, hist ${r.historyTokens}, tool ${r.toolSchemaTokens}, in ${r.newInputTokens}, obs ${r.observationTokens})`,
        );
        if (r.estimationDriftTokens !== undefined) parts.push(`drift ${r.estimationDriftTokens}`);
    }
    return parts.join(' · ');
}

function backToChat() {
    ui.view = 'chat';
}

async function openSystemPicker() {
    try {
        await pickWorkspace();
        await loadWorkspace();
    } catch (error) {
        const msg = String(error).toLowerCase();
        // User cancelling the picker is normal flow, not an error
        if (msg.includes('cancel') || msg.includes('abort') || msg.includes('取消')) return;
        ui.err = String(error);
    }
}

async function exitWorkspace() {
    await selectWorkspace('');
    workspaceMenu.value = false;
}

async function switchProject(path) {
    await selectWorkspace(path);
    workspaceMenu.value = false;
}

async function openConversation(conversation) {
    currentConversation.value = conversation.conversationId;
    const run = latestRun(conversation);
    if (run) {
        await openRun(run.rootGoalId);
    } else {
        current.value = null;
        detail.value = null;
    }
    feedbackSent.value = false;
}

async function createAndRunGoal({ statement, permissionCeiling, maxCostUsd, maxSteps, userId, loopMode }, workspacePath, conversationId, exec) {
    const text = String(statement ?? '').trim();
    if (!text) return null;
    const rootGoalId = await createRun({
        input: text,
        userId: userId || undefined,
        workspacePath,
        conversationId,
        exec,
        goal: {
            permissionCeiling,
            maxCostUsd,
            maxSteps,
            loopMode,
            reasoningLevel: reasoningLevel.value,
            modelId: selectedModel.value,
        },
    });
    if (rootGoalId) {
        feedbackSent.value = false;
    }
    return rootGoalId;
}

async function submitPrompt() {
    const text = prompt.value.trim();
    if (!text || busy.value) {
        return;
    }
    prompt.value = '';
    // New conversations run in the workspace currently shown in the composer;
    // continuing a conversation keeps using the selected workspace too.
    const workspacePath = workspaceRoot.value || undefined;
    await createAndRunGoal(
        goalFromRunSettings(text),
        workspacePath,
        currentConversation.value || undefined,
        true,
    );
}

function openRenameConversation(conversation) {
    promptDialog.value = {
        open: true,
        title: '重命名会话',
        label: '名称',
        value: conversationTitle(conversation),
        confirmText: '保存',
        action: async (title) => {
            await updateConversation(conversation.conversationId, { title });
        },
    };
}

/** Archive a conversation: it leaves the active lists but stays recoverable. */
async function archiveConversation(conversation) {
    await updateConversation(conversation.conversationId, { archived: true });
}

async function removeConversation(conversation) {
    confirmDialog.value = {
        open: true,
        title: '删除会话',
        message: `删除会话「${conversationTitle(conversation)}」？此操作同时删除其 Goal 树。`,
        confirmText: '删除',
        danger: true,
        action: async () => {
            await deleteConversationById(conversation.conversationId);
        },
    };
}

function openRenameProject(project) {
    promptDialog.value = {
        open: true,
        title: '重命名项目',
        label: '名称',
        value: project.title,
        confirmText: '保存',
        action: async (title) => {
            await renameProject(project.path, title);
        },
    };
}

/** Delete a project: every conversation under it is archived, then the config is removed. */
async function removeProjectById(project) {
    confirmDialog.value = {
        open: true,
        title: '删除项目',
        message: `删除项目「${project.title}」？项目下所有会话将被归档。`,
        confirmText: '删除',
        danger: true,
        action: async () => {
            const items = projectConversations(conversations.value, project.path, project.path);
            for (const conversation of items) {
                await updateConversation(conversation.conversationId, { archived: true });
            }
            await deleteWorkspaceProject(project.path);
            await loadConversations();
        },
    };
}

/** FeedbackModal submit handler. */
async function onFeedbackSubmit({ rating, content }) {
    if (!current.value) return;
    await sendFeedback(current.value, rating, content);
    feedbackModal.value = false;
    feedbackSent.value = true;
}

function openSettings() {
    ui.view = 'system-settings';
}

function startResize(e) {
    e.preventDefault();
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    window.addEventListener('pointermove', onResize);
    window.addEventListener('pointerup', endResize);
}

function onResize(e) {
    const width = Math.min(MAX_PANEL_W, Math.max(MIN_PANEL_W, window.innerWidth - e.clientX));
    rightWidth.value = width;
}

function endResize() {
    window.removeEventListener('pointermove', onResize);
    window.removeEventListener('pointerup', endResize);
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
}

/** Event panel: key events only by default; step.* noise is opt-in. */
const showAllEvents = ref(false);
const KEY_EVENT_TYPES = new Set([
    'goal.started', 'goal.ended',
    'tool.invoke', 'tool.result', 'tool.blocked',
    'llm.request', 'llm.response',
    'approval.requested', 'approval.granted', 'approval.denied', 'approval.cancelled',
    'policy.denied',
    'provider.selected', 'provider.fallback',
    'plan.created', 'plan.invalid',
]);
const filteredEvents = computed(() => {
    const key = ui.eventTypes === 'all' ? null : ui.eventTypes;
    let list = key ? events.list.filter((e) => e.type === key) : events.list;
    if (!showAllEvents.value) {
        list = list.filter((e) => KEY_EVENT_TYPES.has(e.type));
    }
    return list.slice().reverse();
});
const eventTypes = computed(() => [
    'all',
    ...new Set(events.list.map((e) => e.type)),
]);

/** API connectivity latency (ms); null = unreachable/timeout */
const apiLatency = ref(null);
let latencyTimer = null;

async function pingApi() {
    const start = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
        await fetch(API_BASE + '/api/health', { signal: controller.signal });
        apiLatency.value = Math.round(performance.now() - start);
    } catch {
        apiLatency.value = null;
    } finally {
        clearTimeout(timeout);
    }
}

onMounted(async () => {
    document.addEventListener('click', () => {
        accountOpen.value = false;
        searchOpen.value = false;
    });
    try {
        await loadConfig();
        await loadConversations();
        await loadWorkspace();
        await loadSystemLogs();
        const firstConversation = activeConvList.value[0];
        if (firstConversation) {
            await openConversation(firstConversation);
        }
    } catch (error) {
        ui.err = String(error);
    }
    pingApi();
    latencyTimer = setInterval(pingApi, 5000);
});

// 打开「日志 / 事件」时刷新系统日志（系统错误可能发生在会话之外）。
watch(drawerTab, (tab) => {
    if (tab === 'log' || tab === 'events') void loadSystemLogs();
});

onBeforeUnmount(() => {
    stopEvents();
    if (latencyTimer) clearInterval(latencyTimer);
});
</script>

<template>
    <TopBar
        :sidebar-open="ui.sidebar"
        :right-open="ui.rightOpen"
        :conversation-title="headerTitle"
        :workspace="headerWorkspace"
        @toggle-sidebar="ui.sidebar = !ui.sidebar"
        @toggle-right="ui.rightOpen = !ui.rightOpen"
    />

    <div class="app-shell" :class="{ 'panel-maximized': panelMaximized }">
        <button v-if="!ui.sidebar" class="sidebar-expand-handle" title="展开侧边栏" @click="ui.sidebar = true">
            <LineIcon name="chevronRight" size="12" />
        </button>
        <aside class="sidebar" :class="{ show: ui.sidebar }">
            <button class="sidebar-handle" title="收起侧边栏" @click="ui.sidebar = false">
                <LineIcon name="chevronLeft" size="12" />
            </button>
            <!-- Settings mode: category nav -->
            <template v-if="ui.view === 'system-settings'">
                <SettingsSidebar
                    :tabs="SETTINGS_TABS"
                    :active-tab="settingsTab"
                    @update:active-tab="settingsTab = $event"
                    @back="backToChat"
                />
            </template>
            <!-- Chat mode: conversation list -->
            <template v-else>
            <Sidebar
                :projects="projects"
                :project-collapsed="projectCollapsed"
                :general-conversations="generalConversations"
                :active-conversation-id="activeConversation?.conversationId"
                :api-latency="apiLatency"
                :conversations="conversations"
                @new-session="startTopConversation"
                @open-system-picker="openSystemPicker"
                @toggle-project="toggleProject"
                @rename-project="openRenameProject"
                @start-project-conversation="startProjectConversation"
                @remove-project="removeProjectById"
                @open-conversation="openConversation"
                @rename-conversation="openRenameConversation"
                @archive-conversation="archiveConversation"
                @remove-conversation="removeConversation"
                @open-settings="openSettings"
            />
            </template>
        </aside>

        <main class="workspace">
            <template v-if="ui.view === 'chat'">
                <div v-if="ui.err && conversations.length" class="error-banner">{{ ui.err }}</div>
                <ChatMain
                    :active-conversation="activeConversation"
                    :workspace-display-name="workspaceDisplayName"
                    :runs="runs"
                    :run-details="runDetails"
                    :current="current"
                    :busy="busy"
                    :live-stream="activeLiveStream"
                    :live-steps="liveSteps"
                    :suggestion-cards="suggestionCards"
                    :feedback-sent="feedbackSent"
                    :prompt="prompt"
                    :projects="projects"
                    :cfg="cfg"
                    :selected-model="selectedModel"
                    :reasoning-level="reasoningLevel"
                    :reasoning-levels="REASONING_LEVELS"
                    :approvals="approvals"
                    :task-count="taskCount"
                    :step-count="stepCount"
                    :stats="conversationStats"
                    :selected-step-id="selectedStepId"
                    :selected-task-id="selectedTaskId"
                    @select-step="onSelectStep"
                    @select-task="onSelectTask"
                    @use-suggestion="useSuggestion"
                    @update:prompt="prompt = $event"
                    @submit="submitPrompt"
                    @switch-project="switchProject"
                    @open-system-picker="openSystemPicker"
                    @exit-workspace="exitWorkspace"
                    @update:selected-model="setSelectedModel"
                    @update:reasoning-level="setReasoningLevel"
                    @respond-approval="onApprovalResponse"
                />
            </template>

            <template v-else-if="ui.view === 'system-settings'">
                <SettingsPage
                    :active-tab="settingsTab"
                    :theme="theme"
                    :cfg="cfg"
                    :selected-model="selectedModel"
                    :reasoning-level="reasoningLevel"
                    :reasoning-levels="REASONING_LEVELS"
                    :syncing="syncingModels"
                    :free-chat-workspace="freeChatWorkspace"
                    :permission-ceiling="cfg?.permissionCeiling || 'read-only'"
                    @update:theme="setTheme"
                    @update:selected-model="setSelectedModel"
                    @update:reasoning-level="setReasoningLevel"
                    @sync-models="syncModels"
                    @save-free-workspace="onSaveFreeChatWorkspace"
                    @pick-free-workspace="onPickFreeChatWorkspace"
                    @save-permission="setPermissionCeiling"
                />
            </template>

            <UserPreferencesPage v-else-if="ui.view === 'settings'" @close="backToChat" />
        </main>

        <div
            v-if="ui.rightOpen && !panelMaximized"
            class="panel-resizer"
            title="拖拽调整宽度"
            @pointerdown="startResize"
        ></div>
        <RightPanel
            :open="ui.rightOpen"
            :maximized="panelMaximized"
            :width="rightWidth"
            :active-tab="drawerTab"
            :current="current"
            :root-outcome="rootOutcome"
            :busy="busy"
            :step-rows="stepEventRows"
            :events="events"
            :filtered-events="filteredEvents"
            :event-types="eventTypes"
            :active-event-type="ui.eventTypes"
            :show-all-events="showAllEvents"
            :audit="auditView"
            :context-rows="conversationAudit.rows"
            :system-logs="systemLogs"
            @refresh-logs="loadSystemLogs()"
            @select-step="onSelectStep"
            @locate-step="onLocateStep"
            @select-conversation="onSelectConversation"
            @update:active-tab="drawerTab = $event"
            @toggle-maximize="togglePanelMax"
            @collapse="ui.rightOpen = false"
            @update:active-event-type="ui.eventTypes = $event"
            @toggle-show-all="showAllEvents = !showAllEvents"
        />
    </div>

    <PromptDialog
        :open="promptDialog.open"
        :title="promptDialog.title"
        :label="promptDialog.label"
        :initial-value="promptDialog.value"
        :confirm-text="promptDialog.confirmText"
        @cancel="cancelPrompt"
        @confirm="confirmPrompt"
    />

    <FeedbackModal
        :open="feedbackModal"
        :subject="short(current, 24)"
        @close="feedbackModal = false"
        @submit="onFeedbackSubmit"
    />

    <ConfirmDialog
        :open="confirmDialog.open"
        :title="confirmDialog.title"
        :message="confirmDialog.message"
        :confirm-text="confirmDialog.confirmText"
        :danger="confirmDialog.danger"
        @cancel="cancelConfirm"
        @confirm="runConfirmAction"
    />
</template>

<style scoped>
/*
 * The app shell only styles what it renders directly. Component-level styles
 * live in each component scoped <style> block, and global base/reset rules live
 * in style/index.css. Keeping this block minimal avoids the cascade leaking into
 * child components (which previously caused duplicated/overridden rules).
 */

/* Draggable divider between the workspace and the right audit panel. */
.panel-resizer {
    width: 5px;
    flex: 0 0 5px;
    cursor: col-resize;
    background: var(--border);
    opacity: 0.35;
    transition: opacity 0.15s ease, background 0.15s ease;
}
.panel-resizer:hover {
    opacity: 1;
    background: var(--accent);
}
</style>
