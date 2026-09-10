<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import LineIcon from './assets/LineIcon.vue';
import ConfirmDialog from './components/ConfirmDialog.vue';
import SettingsPage from './components/SettingsPage.vue';
import SettingsSidebar from './components/SettingsSidebar.vue';
import RightPanel from './components/RightPanel.vue';
import Sidebar from './components/Sidebar.vue';
import ChatMain from './components/ChatMain.vue';
import TopBar from './components/TopBar.vue';
import NewSessionModal from './components/NewSessionModal.vue';
import FeedbackModal from './components/FeedbackModal.vue';
import UserPreferencesPage from './components/UserPreferencesPage.vue';
import { defaultConversations } from './scripts/conversation.ts';
import { createGoalContractDraft, toGoalContractPayload } from './scripts/goal-contract.ts';
import { API_BASE } from './api.js';
import {
    activeLiveStream,
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
    loadConfig,
    loadConversations,
    loadWorkspace,
    openRun,
    pickWorkspace,
    projects,
    renameProject,
    runOutcomes,
    selectWorkspace,
    sendFeedback,
    setTheme,
    short,
    statusLabel,
    stopEvents,
    theme,
    ui,
    updateConversation,
    workspaceRoot,
} from './scripts/store.js';

const prompt = ref('');
const q = ref('');
const drawerTab = ref('log');
const rightWidth = ref(320);
const MIN_PANEL_W = 240;
const MAX_PANEL_W = 640;
const searchOpen = ref(false);
const projectCollapsed = ref(new Set());
const accountOpen = ref(false);
const selectedModel = ref('');
const REASONING_LEVELS = [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
];
const reasoningLevel = ref('high');
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
            selectedModel.value = options[0]?.id || '';
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
const taskCount = computed(() => detail.value?.taskCount ?? 0);
const stepCount = computed(() => detail.value?.stepCount ?? 0);
const rootOutcome = computed(() => (current.value ? runOutcomes[current.value] : null));
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

/** Pending workspace for the next new conversation (set by the project "+" menu). */
const pendingWorkspace = ref('');
/** Set when the default "+" was used: force a workspace-less conversation. */
const noWorkspaceNew = ref(false);

function startTopConversation() {
    // Jump to the blank welcome screen (no goal modal); user types in composer
    currentConversation.value = null;
    current.value = null;
    detail.value = null;
    stopEvents();
}

function startProjectConversation(project) {
    pendingWorkspace.value = project.path;
    noWorkspaceNew.value = false;
    ui.showNew = true;
}

function startGeneralConversation() {
    pendingWorkspace.value = '';
    noWorkspaceNew.value = true;
    ui.showNew = true;
}

/**
 * NewSessionModal submit handler.
 *
 * The dialog always starts a brand new Conversation placed either in the pending
 * workspace or in the default (workspace-less) group; it never continues the
 * currently open conversation.
 */
async function onNewSessionSubmit({ goal, exec }) {
    const workspacePath = noWorkspaceNew.value
        ? undefined
        : pendingWorkspace.value || workspaceRoot.value || undefined;
    pendingWorkspace.value = '';
    noWorkspaceNew.value = false;
    await createAndRunGoal(goal, workspacePath, undefined, exec);
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
    // Continue the open conversation inside its workspace; a fresh conversation
    // stays standalone and does not inherit the current workspace.
    const workspacePath = currentConversation.value ? workspaceRoot.value : undefined;
    const goal = { statement: text, ...toGoalContractPayload(createGoalContractDraft()) };
    await createAndRunGoal(goal, workspacePath, currentConversation.value || undefined, true);
}

async function renameConversationById(conversation) {
    const title = window.prompt('重命名会话', conversationTitle(conversation));
    if (title?.trim()) {
        await updateConversation(conversation.conversationId, { title: title.trim() });
    }
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

async function renameProjectById(project) {
    const title = window.prompt('重命名项目', project.title);
    if (title?.trim()) {
        await renameProject(project.path, title.trim());
    }
}

async function removeProjectById(project) {
    confirmDialog.value = {
        open: true,
        title: '删除项目配置',
        message: `删除项目「${project.title}」的配置？仅删除配置，对话记录保留并移入“会话”区。`,
        confirmText: '删除',
        danger: true,
        action: async () => {
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

onBeforeUnmount(() => {
    stopEvents();
    if (latencyTimer) clearInterval(latencyTimer);
});
</script>

<template>
    <TopBar
        :sidebar-open="ui.sidebar"
        :right-open="ui.rightOpen"
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
                @rename-project="renameProjectById"
                @start-project-conversation="startProjectConversation"
                @remove-project="removeProjectById"
                @open-conversation="openConversation"
                @rename-conversation="renameConversationById"
                @remove-conversation="removeConversation"
                @start-general-conversation="startGeneralConversation"
                @open-settings="openSettings"
            />
            </template>
        </aside>

        <main class="workspace">
            <template v-if="ui.view === 'chat'">
                <div v-if="ui.err && conversations.length" class="error-banner">{{ ui.err }}</div>
                <ChatMain
                    :active-conversation="activeConversation"
                    :workspace-root="workspaceRoot"
                    :workspace-display-name="workspaceDisplayName"
                    :runs="runs"
                    :run-details="runDetails"
                    :current="current"
                    :busy="busy"
                    :live-stream="activeLiveStream"
                    :suggestion-cards="suggestionCards"
                    :feedback-sent="feedbackSent"
                    :prompt="prompt"
                    :projects="projects"
                    :cfg="cfg"
                    :selected-model="selectedModel"
                    :reasoning-level="reasoningLevel"
                    :reasoning-levels="REASONING_LEVELS"
                    :task-count="taskCount"
                    :step-count="stepCount"
                    @use-suggestion="useSuggestion"
                    @update:prompt="prompt = $event"
                    @submit="submitPrompt"
                    @switch-project="switchProject"
                    @open-system-picker="openSystemPicker"
                    @exit-workspace="exitWorkspace"
                    @update:selected-model="selectedModel = $event"
                    @update:reasoning-level="reasoningLevel = $event"
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
                    @update:theme="setTheme"
                    @update:selected-model="selectedModel = $event"
                    @update:reasoning-level="reasoningLevel = $event"
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
            @update:active-tab="drawerTab = $event"
            @toggle-maximize="togglePanelMax"
            @collapse="ui.rightOpen = false"
            @update:active-event-type="ui.eventTypes = $event"
            @toggle-show-all="showAllEvents = !showAllEvents"
        />
    </div>

    <NewSessionModal
        :open="ui.showNew"
        :busy="busy"
        @close="ui.showNew = false"
        @submit="onNewSessionSubmit"
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
