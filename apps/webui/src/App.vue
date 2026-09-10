<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import LineIcon from './assets/LineIcon.vue';
import ConfirmDialog from './components/ConfirmDialog.vue';
import SettingsPage from './components/SettingsPage.vue';
import SettingsSidebar from './components/SettingsSidebar.vue';
import RightPanel from './components/RightPanel.vue';
import Sidebar from './components/Sidebar.vue';
import ChatMain from './components/ChatMain.vue';
import { defaultConversations } from './scripts/conversation.ts';
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
    saveUserPreferences,
    selectWorkspace,
    sendFeedback,
    setTheme,
    short,
    statusLabel,
    stopEvents,
    theme,
    ui,
    updateConversation,
    userPreferences,
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
const feedbackRating = ref(5);
const feedbackContent = ref('');
/** 工作区选择菜单 */
const workspaceMenu = ref(false);
/** 推荐卡片（空状态展示） */
const suggestionCards = [
    { icon: 'search', title: 'Explore and understand code', color: '#3b82f6', prompt: '帮我探索和理解这个代码库的结构和核心逻辑' },
    { icon: 'hammer', title: 'Build a new feature, app, or tool', color: '#8b5cf6', prompt: '帮我构建一个新功能、应用或工具' },
    { icon: 'refresh', title: 'Review code and suggest changes', color: '#10b981', prompt: '帮我审查代码并提出改进建议' },
    { icon: 'bug', title: 'Fix issues and failures', color: '#f97316', prompt: '帮我定位并修复问题和故障' },
];
/** 当前工作区显示名（取路径最后一段） */
const workspaceDisplayName = computed(() => {
    const p = workspaceRoot.value;
    if (!p) return '';
    const parts = p.replace(/\/+$/, '').split('/');
    return parts[parts.length - 1] || p;
});
function useSuggestion(card) {
    prompt.value = card.prompt;
}
/** 自定义确认弹窗（替代 window.confirm） */
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
const draft = ref({
    statement: '',
    permission: 'read-only',
    budgetUsd: 0.5,
    maxSteps: 8,
    userId: '',
    loopMode: 'goal-plan-execute-reflect',
});
const LOOP_MODE_OPTIONS = [
    { value: 'goal-plan-execute-reflect', label: 'GPER · 默认' },
    { value: 'goal-plan-execute', label: 'Plan-Execute' },
    { value: 'react-only', label: 'React Only' },
];
const preferences = ref({ ...userPreferences });

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
/** 右侧面板最大化（覆盖主页面） */
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

/** 目标工作区（点项目/会话区 ＋ 后生效），用于新会话归属 */
const pendingWorkspace = ref('');
/** 会话区 ＋ → 强制普通会话（不挂任何工作区） */
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

async function submitNew(exec) {
    const ws = noWorkspaceNew.value
        ? undefined
        : pendingWorkspace.value || workspaceRoot.value || undefined;
    pendingWorkspace.value = '';
    noWorkspaceNew.value = false;
    // “新会话”弹窗恒建新 Conversation（归属 ws 指定工作区或普通区），不续接当前打开的会话
    await createAndRunGoal(
        {
            statement: draft.value.statement,
            permissionCeiling: draft.value.permission,
            maxCostUsd: draft.value.budgetUsd,
            maxSteps: draft.value.maxSteps,
            userId: draft.value.userId || undefined,
            loopMode: draft.value.loopMode,
        },
        ws,
        undefined,
        exec,
    );
    draft.value.statement = '';
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

/** 步骤流：收集 step.started + step.ended，计算耗时，结构化 usage 用于看板展示 */
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

/** 带毫秒的时间格式：HH:MM:SS.mmm */
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

/** 两维度 token 统计摘要文本 */
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
    // New conversation (no currentConversation): do not inherit current workspace,
    // it is a fresh standalone conversation. Continue existing conversation: keep its workspace.
    const ws = currentConversation.value ? workspaceRoot.value : undefined;
    await createAndRunGoal(
        {
            statement: text,
            permissionCeiling: draft.value.permission,
            maxCostUsd: draft.value.budgetUsd,
            maxSteps: draft.value.maxSteps,
            userId: draft.value.userId || undefined,
            loopMode: draft.value.loopMode,
        },
        ws,
        currentConversation.value || undefined,
        true,
    );
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

async function submitFeedback() {
    if (!current.value) return;
    await sendFeedback(current.value, feedbackRating.value, feedbackContent.value);
    feedbackModal.value = false;
    feedbackSent.value = true;
}

function savePreferences() {
    saveUserPreferences(preferences.value);
    backToChat();
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

/** 事件面板：默认仅展示关键事件（goal/tool/llm/approval/policy/provider），step.* 噪音可展开 */
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
    <header class="topbar">
        <div class="topbar-left">
            <button class="icon-btn sidebar-toggle" title="折叠/展开侧边栏" @click="ui.sidebar = !ui.sidebar">
                <LineIcon name="menu" />
            </button>
            <span class="brand">mazi</span>
            <span class="slogan">Be water, my friend</span>
        </div>
        <div class="topbar-right">
            <button
                class="ghost right-toggle"
                :title="ui.rightOpen ? '收起事件栏' : '展开事件栏'"
                @click="ui.rightOpen = !ui.rightOpen"
            >
                <LineIcon name="panel" />
            </button>
        </div>
    </header>

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

            <template v-else-if="ui.view === 'settings'">
                <div class="page-card">
                    <div class="page-heading">
                        <button class="icon-btn back-btn" title="返回会话" @click="backToChat">
                            <LineIcon name="chevronRight" size="16" />
                        </button>
                        <h1>个人设置</h1>
                    </div>
                    <div class="field-row"><label>用户名</label><input v-model="preferences.displayName" /></div>
                    <div class="field-row"><label>常用工具 / 喜好</label><input v-model="preferences.favoriteTools" placeholder="例如：Vue、TypeScript、终端工作流" /></div>
                    <div class="field-row"><label>代码风格</label><textarea v-model="preferences.codeStyle" rows="3" /></div>
                    <div class="field-row"><label>模型回答风格</label><textarea v-model="preferences.responseStyle" rows="3" /></div>
                    <div class="page-actions">
                        <button class="ghost" @click="backToChat">取消</button>
                        <button class="primary" @click="savePreferences">保存</button>
                    </div>
                </div>
            </template>
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

    <div v-if="ui.showNew" class="modal-mask" @click.self="ui.showNew = false">
        <div class="modal">
            <h1>新建会话 · GoalContract</h1>
            <div class="field-row">
                <label>任务</label>
                <textarea v-model="draft.statement" rows="3" placeholder="目标陈述，例如：读取 README.md 并汇报"></textarea>
            </div>
            <div class="grid2">
                <div class="field-row">
                    <label>权限上限</label>
                    <select v-model="draft.permission">
                        <option v-for="p in ['text', 'read-only', 'draft', 'approved', 'autonomous']" :key="p" :value="p">{{ p }}</option>
                    </select>
                </div>
                <div class="field-row"><label>预算（USD）</label><input v-model.number="draft.budgetUsd" type="number" step="0.1" /></div>
                <div class="field-row"><label>最大步数</label><input v-model.number="draft.maxSteps" type="number" /></div>
                <div class="field-row"><label>UserId（可选）</label><input v-model="draft.userId" placeholder="me" /></div>
                <div class="field-row">
                    <label>Loop 模式</label>
                    <select v-model="draft.loopMode">
                        <option v-for="m in LOOP_MODE_OPTIONS" :key="m.value" :value="m.value">{{ m.label }}</option>
                    </select>
                </div>
            </div>
            <div class="modal-actions">
                <button class="ghost" @click="ui.showNew = false">取消</button>
                <button @click="submitNew(false)">仅创建</button>
                <button class="primary" :disabled="busy" @click="submitNew(true)">创建并运行</button>
            </div>
        </div>
    </div>

    <div v-if="feedbackModal" class="modal-mask" @click.self="feedbackModal = false">
        <div class="modal">
            <h1>反馈 · {{ short(current, 24) }}</h1>
            <div class="field-row"><label>评分</label><select v-model="feedbackRating"><option v-for="n in 5" :key="n" :value="n">{{ n }}</option></select></div>
            <div class="field-row"><label>说明</label><textarea v-model="feedbackContent" rows="3" placeholder="补充说明（可选）"></textarea></div>
            <div class="modal-actions">
                <button class="ghost" @click="feedbackModal = false">取消</button>
                <button class="primary" @click="submitFeedback">提交</button>
            </div>
        </div>
    </div>

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
