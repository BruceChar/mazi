<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import LineIcon from './LineIcon.vue';
import { defaultConversations, projectConversations } from './sidebar.ts';
import {
    busy,
    cfg,
    conversations,
    createRun,
    current,
    deleteWorkspaceProject,
    currentConversation,
    deleteConversationById,
    detail,
    events,
    executeRun,
    fmtClock,
    loadConfig,
    loadConversations,
    loadWorkspace,
    openConversation as storeOpenConversation,
    openRun,
    pickWorkspace,
    projects,
    relTime,
    renameProject,
    runOutcomes,
    saveUserPreferences,
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
} from './store.js';

const prompt = ref('');
const q = ref('');
const drawerTab = ref('log');
const rightWidth = ref(320);
const MIN_PANEL_W = 240;
const MAX_PANEL_W = 640;
const searchOpen = ref(false);
const projectCollapsed = ref({});
const projectMenuFor = ref('');
const accountOpen = ref(false);
const selectedModel = ref('');
const pickerType = ref(/** @type {'model'|'reasoning'|null} */ (null));
const REASONING_LEVELS = [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
];
const reasoningLevel = ref('high');
const reasoningLabel = computed(() => REASONING_LEVELS.find((r) => r.value === reasoningLevel.value)?.label || 'High');
const currentModelLabel = computed(() => modelOptions.value.find((m) => m.id === selectedModel.value)?.label?.replace(/\s+(Low|Medium|High)$/i, '') || selectedModel.value);
const feedbackSent = ref(false);
const feedbackModal = ref(false);
const feedbackRating = ref(5);
const feedbackContent = ref('');
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
    return providers.map((id) => ({
        id,
        label: id === 'deepseek' ? 'DeepSeek-V4-Flash High' : id,
    }));
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
const activeGoals = computed(() => detail.value?.goals || []);
const taskCount = computed(() => detail.value?.taskCount ?? 0);
const stepCount = computed(() => detail.value?.stepCount ?? 0);
const rootOutcome = computed(() => (current.value ? runOutcomes[current.value] : null));
const currentInput = computed(() => {
    const run = runs.value.find((r) => r.rootGoalId === current.value);
    return run?.input || '';
});
const workedFor = computed(() => '');
/** 聊天流中展开了执行过程的 run（默认当前 run） */
const expandedRunId = ref(null);
/** 右侧面板最大化（覆盖主页面） */
const panelMaximized = ref(false);
function togglePanelMax() {
    panelMaximized.value = !panelMaximized.value;
}
/** 执行过程（goal 树）展开/折叠 */
const showExecution = ref(true);
/** 当前 run 总耗时（从 stepEventRows 汇总） */
const totalDuration = computed(() => {
    const ms = stepEventRows.value.reduce((s, r) => s + (r.durationMs || 0), 0);
    return formatDuration(ms);
});
/** 执行流统计：步数、LLM 耗时、工具耗时、token 总量 */
const execStats = computed(() => {
    const rows = stepEventRows.value;
    const thinkingMs = rows.filter((r) => r.kind === 'thinking').reduce((s, r) => s + (r.durationMs || 0), 0);
    const toolMs = rows.filter((r) => r.kind === 'tool_call').reduce((s, r) => s + (r.durationMs || 0), 0);
    const totalTokens = rows.reduce((s, r) => s + (usageStats(r.usage)?.total || 0), 0);
    return {
        steps: rows.length,
        thinkingTime: formatDuration(thinkingMs),
        toolTime: formatDuration(toolMs),
        totalTokens,
    };
});
/** 执行流分层：goal → task → step（元信息来自 goalSnapshot，steps 来自事件流） */
const execTree = computed(() => {
    const goals = detail.value?.goals || [];
    return goals.map((goal) => ({
        goalId: goal.goalId,
        statement: goal.statement,
        status: goal.status,
        tasks: (goal.tasks || []).map((task) => ({
            taskId: task.taskId,
            title: task.title,
            status: task.status,
            steps: stepEventRows.value.filter((s) => s.taskId === task.taskId),
        })),
    }));
});
/** goal/task 折叠状态 */
const collapsedGoals = ref(new Set());
const collapsedTasks = ref(new Set());
/** step 内容折叠状态（默认展开，点击 dot 折叠） */
const collapsedSteps = ref(new Set());
function toggleStepCollapse(key) {
    const s = new Set(collapsedSteps.value);
    s.has(key) ? s.delete(key) : s.add(key);
    collapsedSteps.value = s;
}
/** 内容是否超过单行（>80 字符或含换行），仅长内容支持折叠 */
function isStepLong(row) {
    if (!row.text) return false;
    return row.text.length > 80 || row.text.includes('\n');
}
function toggleGoal(goalId) {
    const s = new Set(collapsedGoals.value);
    s.has(goalId) ? s.delete(goalId) : s.add(goalId);
    collapsedGoals.value = s;
}
function toggleTask(taskId) {
    const s = new Set(collapsedTasks.value);
    s.has(taskId) ? s.delete(taskId) : s.add(taskId);
    collapsedTasks.value = s;
}
/** 模型输出时间：取最后一个 step 结束时间，无则用 run 创建时间 */
function assistantTime(run) {
    const last = stepEventRows.value[stepEventRows.value.length - 1];
    return last ? last.time : fmtClock(run.createdAt);
}
/** 执行流步骤 title 摘要：失败时显示错误消息，否则显示内容前 80 字 */
function stepTitleSummary(row) {
    const isError = row.status === 'error' || row.status === 'failed';
    if (isError) {
        return row.text ? `Error: ${row.text.slice(0, 80)}` : '执行失败';
    }
    return row.text ? row.text.slice(0, 80) : '';
}

function conversationTitle(conversation) {
    const run = latestRun(conversation);
    return conversation?.title || run?.input || '';
}

function conversationOutcome(conversation) {
    const run = latestRun(conversation);
    if (!run) return 'new';
    const outcome = runOutcomes[run.rootGoalId];
    return outcome ? (outcome.ok ? 'success' : 'failed') : 'goal';
}

function badge(outcome) {
    if (outcome === 'success') return 'success';
    if (outcome === 'failed') return 'failed';
    if (outcome === 'new') return 'new';
    return 'goal';
}

function isConversationActive(conversation) {
    return currentConversation.value === conversation.conversationId;
}

function projectConversationItems(project) {
    return projectConversations(activeConvList.value, project.path, project.path);
}

/** 目标工作区（点项目/会话区 ＋ 后生效），用于新会话归属 */
const pendingWorkspace = ref('');
/** 会话区 ＋ → 强制普通会话（不挂任何工作区） */
const noWorkspaceNew = ref(false);

function startTopConversation() {
    pendingWorkspace.value = '';
    noWorkspaceNew.value = false;
    ui.showNew = true;
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

function isProjectOpen(path) {
    return projectCollapsed.value[path] !== true;
}

function toggleProject(path) {
    projectCollapsed.value[path] = !projectCollapsed.value[path];
}

function statusClass(status) {
    if (['succeeded', 'ok'].includes(status)) return 'succeeded';
    if (['failed', 'error', 'blocked', 'aborted', 'timeout', 'rolled_back'].includes(status)) {
        return 'failed';
    }
    if (['active', 'pending', 'running'].includes(status)) return status;
    return '';
}

function kindGlyph(kind) {
    if (kind === 'thinking') return '💭';
    if (kind === 'tool_call') return '🔧';
    if (kind === 'observation') return '👁';
    return '•';
}

function kindLabel(kind) {
    if (kind === 'thinking') return '思考';
    if (kind === 'tool_call') return '工具';
    if (kind === 'observation') return '观察';
    return kind || '-';
}

/** Step 内容摘要：thinking 取 content，tool_call 取 toolName+参数，observation 取 content */
function stepSummary(step) {
    const p = step.payload || {};
    if (step.kind === 'tool_call') {
        const args = p.arguments ? JSON.stringify(p.arguments).slice(0, 80) : '';
        return `${p.toolName || 'tool'}(${args})`;
    }
    const content = p.content ? String(p.content) : '';
    return content.slice(0, 120);
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
            text: p.content ? String(p.content) : '',
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

/** 从 usage 提取结构化 token 统计，用于看板展示 */
function usageStats(usage) {
    if (!usage) return null;
    const v = usage.vendor || {};
    const r = usage.runtime || {};
    const input = v.inputTokens ?? 0;
    const output = v.outputTokens ?? 0;
    const cache = v.cacheReadInputTokens ?? 0;
    const reasoning = v.reasoningOutputTokens ?? 0;
    const total = input + output;
    return {
        input, output, cache, reasoning, total,
        context: r.totalContextTokens ?? null,
        hasData: total > 0 || cache > 0 || reasoning > 0,
    };
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

function runLabel(run) {
    return short(run.input, 48) || run.rootGoalId;
}

function cycleTheme() {
    setTheme(theme.value === 'dark' ? 'light' : 'dark');
}

function backToChat() {
    ui.view = 'chat';
}

async function openSystemPicker() {
    try {
        await pickWorkspace();
        await loadWorkspace();
    } catch (error) {
        ui.err = String(error);
    }
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

async function selectRun(run) {
    await openRun(run.rootGoalId);
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
    await createAndRunGoal(
        {
            statement: text,
            permissionCeiling: draft.value.permission,
            maxCostUsd: draft.value.budgetUsd,
            maxSteps: draft.value.maxSteps,
            userId: draft.value.userId || undefined,
            loopMode: draft.value.loopMode,
        },
        workspaceRoot.value,
        currentConversation.value || undefined,
        true,
    );
}

async function rerunCurrent() {
    await executeRun(current.value);
    feedbackSent.value = false;
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

function openRate() {
    const outcome = rootOutcome.value;
    feedbackRating.value = outcome?.ok ? 5 : 3;
    feedbackContent.value = '';
    feedbackModal.value = true;
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

/** 事件 payload 摘要（替代无意义的 sessionId 展示） */
function eventSummary(e) {
    const p = e.payload || {};
    if (e.type === 'goal.started') return p.rawInput ? String(p.rawInput).slice(0, 60) : '';
    if (e.type === 'goal.ended') return p.outcome?.summary ? String(p.outcome.summary).slice(0, 60) : (p.outcome?.status || '');
    if (e.type === 'tool.invoke' || e.type === 'tool.result') return p.toolName || '';
    if (e.type === 'llm.request' || e.type === 'llm.response') return p.model || '';
    if (e.type === 'approval.requested') return p.toolName || p.effectClass || '';
    if (e.type === 'provider.selected') return p.providerId || '';
    return '';
}
function eventColorClass(type) {
    if (type.startsWith('goal.')) return 'ev-goal';
    if (type.startsWith('tool.')) return 'ev-tool';
    if (type.startsWith('llm.')) return 'ev-llm';
    if (type.startsWith('approval.')) return 'ev-approval';
    if (type.startsWith('policy.')) return 'ev-policy';
    if (type.startsWith('provider.')) return 'ev-provider';
    if (type.startsWith('step.')) return 'ev-step';
    return 'ev-other';
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
});

onBeforeUnmount(() => {
    stopEvents();
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
            <button
                class="icon-btn"
                :title="theme === 'dark' ? '切换到浅色' : '切换到深色'"
                @click="cycleTheme"
            >
                <LineIcon :name="theme === 'dark' ? 'sun' : 'moon'" />
            </button>
        </div>
    </header>

    <div class="app-shell">
        <aside class="sidebar" :class="{ show: ui.sidebar }">
            <div class="sidebar-new">
                <button class="primary new-session" @click="startTopConversation">
                    <LineIcon name="plus" size="15" />
                    新会话
                </button>
            </div>
            <div class="workspace-head">
                <span>工作区</span>
                <span class="head-icons">
                    <button class="head-icon" title="搜索" @click.stop="searchOpen = !searchOpen">
                        <LineIcon name="search" size="14" />
                    </button>
                    <button class="head-icon" title="打开/创建工作区" @click.stop="openSystemPicker">
                        <LineIcon name="plus" size="14" />
                    </button>
                </span>
            </div>
            <div v-if="searchOpen" class="search-box">
                <input v-model="q" placeholder="搜索会话…" />
            </div>
            <div class="sidebar-scroll">
                <div v-for="project in projects" :key="project.path" class="group">
                    <div
                        class="group-head project-head"
                        :title="project.path"
                        @mouseenter="projectMenuFor = project.path"
                        @mouseleave="projectMenuFor = ''"
                    >
                        <button
                            class="head-icon project-fold"
                            :title="isProjectOpen(project.path) ? '折叠' : '展开'"
                            @click.stop="toggleProject(project.path)"
                        >
                            <LineIcon :name="isProjectOpen(project.path) ? 'chevronDown' : 'chevronRight'" size="13" />
                        </button>
                        <span class="project-title">{{ project.title }}</span>
                        <button
                            v-if="projectMenuFor === project.path"
                            class="head-icon"
                            title="重命名项目"
                            @click.stop="renameProjectById(project)"
                        >
                            <LineIcon name="rename" size="13" />
                        </button>
                        <button
                            v-if="projectMenuFor === project.path"
                            class="head-icon project-add"
                            title="添加项目会话"
                            @click.stop="startProjectConversation(project)"
                        >
                            <LineIcon name="plus" size="13" />
                        </button>
                        <button
                            v-if="projectMenuFor === project.path"
                            class="head-icon project-remove"
                            title="删除项目配置"
                            @click.stop="removeProjectById(project)"
                        >
                            <LineIcon name="trash" size="13" />
                        </button>
                    </div>
                    <ul class="session-list">
                        <template v-if="isProjectOpen(project.path)">
                            <li
                                v-for="c in projectConversationItems(project)"
                                :key="c.conversationId"
                                :class="{ active: isConversationActive(c) }"
                                @click="openConversation(c)"
                            >
                                <div class="session-title">{{ conversationTitle(c) }}</div>
                                <div class="session-actions">
                                    <button title="重命名会话" @click.stop="renameConversationById(c)"><LineIcon name="rename" size="13" /></button>
                                    <button title="删除会话" @click.stop="removeConversation(c)"><LineIcon name="trash" size="13" /></button>
                                </div>
                                <div class="session-time">{{ relTime(c.updatedAt || c.createdAt) }}</div>
                            </li>
                            <li v-if="!projectConversationItems(project).length" class="empty-sidebar">
                                暂无项目会话
                            </li>
                        </template>
                    </ul>
                </div>
                <div class="group">
                    <div class="group-head">
                        <span>会话 · {{ generalConversations.length }}</span>
                        <span class="head-icons">
                            <button class="head-icon" title="添加新会话" @click.stop="startGeneralConversation">
                                <LineIcon name="plus" size="14" />
                            </button>
                        </span>
                    </div>
                    <ul class="session-list">
                        <li
                            v-for="c in generalConversations"
                            :key="c.conversationId"
                            :class="{ active: isConversationActive(c) }"
                            @click="openConversation(c)"
                        >
                            <div class="session-title">{{ conversationTitle(c) }}</div>
                            <div class="session-actions">
                                <button title="重命名会话" @click.stop="renameConversationById(c)"><LineIcon name="rename" size="13" /></button>
                                <button title="删除会话" @click.stop="removeConversation(c)"><LineIcon name="trash" size="13" /></button>
                            </div>
                            <div class="session-time">{{ relTime(c.updatedAt || c.createdAt) }}</div>
                        </li>
                        <li v-if="!generalConversations.length" class="empty-sidebar">暂无会话</li>
                    </ul>
                </div>
            </div>
            <div class="sidebar-settings">
                <button class="settings-btn" @click="openSettings">
                    <LineIcon name="settings" size="15" />
                    系统设置
                </button>
            </div>
        </aside>

        <main class="workspace">
            <template v-if="ui.view === 'chat'">
                <div v-if="ui.err && conversations.length" class="error-banner">{{ ui.err }}</div>

                <template v-if="activeConversation">
                    <div class="goal-conv-head">
                        <span class="goal-conv-title">{{ conversationTitle(activeConversation) }}</span>
                        <span v-if="workspaceRoot" class="goal-conv-ws">{{ workspaceRoot }}</span>
                    </div>
                </template>

                <div class="chat-scroll">
                    <template v-if="activeConversation && runs.length">
                        <div v-for="run in runs" :key="run.rootGoalId" class="run-block" :class="{ current: run.rootGoalId === current }">
                            <!-- 用户输入 -->
                            <div class="msg msg-user">
                                <div class="msg-bubble">{{ run.input }}</div>
                                <span class="msg-time">{{ fmtClock(run.createdAt) }}</span>
                            </div>
                            <!-- 最终回答 -->
                            <div
                                v-if="runOutcomes[run.rootGoalId] && (runOutcomes[run.rootGoalId].finalMessage || runOutcomes[run.rootGoalId].errorMessage)"
                                class="msg msg-assistant"
                            >
                                <div class="msg-bubble" :class="{ fail: !runOutcomes[run.rootGoalId].ok }">
                                    <div class="msg-bubble-head">
                                        {{ runOutcomes[run.rootGoalId].ok ? '最终回答' : '执行失败' }}
                                        <template v-if="runOutcomes[run.rootGoalId].reason"> · {{ runOutcomes[run.rootGoalId].reason }}</template>
                                    </div>
                                    <pre class="msg-final">{{ runOutcomes[run.rootGoalId].ok ? runOutcomes[run.rootGoalId].finalMessage : runOutcomes[run.rootGoalId].errorMessage }}</pre>
                                </div>
                                <div class="msg-meta">
                                    <span class="msg-time">{{ assistantTime(run) }}</span>
                                    <div class="msg-feedback">
                                        <button class="fb-btn" title="点赞"><LineIcon name="like" size="13" /></button>
                                        <button class="fb-btn" title="踩"><LineIcon name="dislike" size="13" /></button>
                                    </div>
                                </div>
                            </div>
                            <!-- 执行中提示 -->
                            <div v-else-if="run.rootGoalId === current && busy" class="msg msg-assistant">
                                <div class="msg-bubble thinking-bubble">执行中…</div>
                            </div>
                            <!-- 执行时间分隔线 -->
                            <div
                                v-if="run.rootGoalId === current && stepEventRows.length"
                                class="worked-for"
                                @click="showExecution = !showExecution"
                            >
                                <span class="worked-for-line"></span>
                                <span class="worked-for-text">Worked for {{ totalDuration }}</span>
                                <LineIcon :name="showExecution ? 'chevronDown' : 'chevronRight'" size="12" />
                                <span class="worked-for-line"></span>
                            </div>
                            <!-- 执行流（goal → task → step 分层，可折叠，仅当前 run） -->
                            <template v-if="run.rootGoalId === current && showExecution">
                                <div v-if="execTree.length" class="exec-stream">
                                    <div v-for="(goal, gIdx) in execTree" :key="goal.goalId" class="exec-goal">
                                        <div class="exec-goal-head" @click="toggleGoal(goal.goalId)">
                                            <span class="exec-dot goal-dot" :class="{ collapsed: collapsedGoals.has(goal.goalId) }"></span>
                                            <span class="exec-goal-tag">G#{{ gIdx + 1 }}</span>
                                            <span class="exec-goal-title">{{ goal.statement }}</span>
                                            <span class="exec-goal-count">{{ goal.tasks.length }} tasks · {{ goal.tasks.reduce((s, t) => s + t.steps.length, 0) }} steps</span>
                                        </div>
                                        <div v-if="!collapsedGoals.has(goal.goalId)" class="exec-goal-body">
                                            <div v-for="(task, tIdx) in goal.tasks" :key="task.taskId" class="exec-task">
                                                <div class="exec-task-head" @click="toggleTask(task.taskId)">
                                                    <span class="exec-dot task-dot" :class="{ collapsed: collapsedTasks.has(task.taskId) }"></span>
                                                    <span class="exec-task-tag">T#{{ tIdx + 1 }}</span>
                                                    <span class="exec-task-title">{{ task.title }}</span>
                                                    <span class="exec-task-count">{{ task.steps.length }} steps</span>
                                                </div>
                                                <div v-if="!collapsedTasks.has(task.taskId)" class="exec-task-body">
                                                    <div
                                                        v-for="(row, sIdx) in task.steps"
                                                        :key="row.key"
                                                        class="exec-step"
                                                        :class="[`exec-${row.kind}`, { error: row.status === 'error' || row.status === 'failed' }]"
                                                    >
                                                        <div class="exec-step-head" :class="{ clickable: isStepLong(row) }" @click="isStepLong(row) && toggleStepCollapse(row.key)">
                                                            <span class="step-dot" :class="{ collapsed: collapsedSteps.has(row.key), interactive: isStepLong(row) }"></span>
                                                            <LineIcon :name="row.kind === 'thinking' ? 'thinking' : row.kind === 'tool_call' ? 'tool' : 'observation'" size="14" />
                                                            <span class="exec-step-tag">S#{{ sIdx + 1 }}</span>
                                                            <span class="exec-step-name">{{ row.toolName || (row.kind === 'thinking' ? '思考' : row.kind === 'observation' ? '观察' : row.kind) }}</span>
                                                            <span class="exec-step-summary">{{ stepTitleSummary(row) }}</span>
                                                            <span v-if="row.duration" class="exec-step-duration">{{ row.duration }}</span>
                                                            <span class="exec-step-time">{{ row.time }}</span>
                                                        </div>
                                                        <div v-if="isStepLong(row) && !collapsedSteps.has(row.key) && row.text" class="exec-step-code">
                                                            <pre class="exec-step-code-inner">{{ row.text }}</pre>
                                                        </div>
                                                        <div v-if="usageStats(row.usage)?.hasData" class="exec-step-usage">
                                                            {{ usageStats(row.usage).total }} tokens
                                                            <template v-if="usageStats(row.usage).cache"> · cache {{ usageStats(row.usage).cache }}</template>
                                                        </div>
                                                    </div>
                                                    <div v-if="!task.steps.length" class="empty-hint">（该 Task 尚无 Step）</div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                    <!-- 执行流底部统计栏 -->
                                    <div class="exec-stats">
                                        <span>{{ execStats.steps }} 步</span>
                                        <span>·</span>
                                        <span>LLM {{ execStats.thinkingTime }}</span>
                                        <span>·</span>
                                        <span>工具 {{ execStats.toolTime }}</span>
                                        <span>·</span>
                                        <span>{{ execStats.totalTokens }} tokens</span>
                                    </div>
                                </div>
                                <div v-else-if="!busy" class="empty-hint">暂无执行步骤</div>
                            </template>
                            <!-- 非当前 run 不展示执行流 -->
                        </div>
                    </template>
                    <div v-else-if="activeConversation" class="empty-hint">
                        暂无 run，输入任务开始
                    </div>
                    <div v-else class="empty-hint">暂无会话，点击「新会话」开始</div>
                </div>

                <div v-if="feedbackSent" class="ok-banner">反馈已记录</div>

                <div class="input-area">
                    <div class="input-composer">
                        <div class="input-top">
                            <button class="input-add" title="选择/创建工作区" @click="openSystemPicker">
                                <LineIcon name="plus" size="16" />
                            </button>
                            <textarea
                                v-model="prompt"
                                rows="1"
                                placeholder="输入任务…（Enter 发送，Shift+Enter 换行）"
                                @keydown.enter.exact.prevent="submitPrompt"
                            ></textarea>
                        </div>
                        <div class="input-footer">
                            <div class="input-footer-left"></div>
                            <div class="input-footer-right">
                                <div class="picker-wrap">
                                    <div v-if="pickerType === 'model'" class="picker-backdrop" @click="pickerType = null"></div>
                                    <button
                                        class="picker-btn model-btn"
                                        :class="{ active: pickerType === 'model' }"
                                        title="select model"
                                        @click="pickerType = pickerType === 'model' ? null : 'model'"
                                    >
                                        {{ currentModelLabel }}
                                    </button>
                                    <div v-if="pickerType === 'model'" class="picker-panel picker-panel-y">
                                        <div
                                            v-for="m in modelOptions"
                                            :key="m.id"
                                            class="picker-option"
                                            :class="{ active: m.id === selectedModel }"
                                            @click="selectedModel = m.id; pickerType = null"
                                        >
                                            {{ m.label.replace(/\s+(Low|Medium|High)$/i, '') }}
                                        </div>
                                    </div>
                                </div>
                                <div class="picker-wrap">
                                    <div v-if="pickerType === 'reasoning'" class="picker-backdrop" @click="pickerType = null"></div>
                                    <button
                                        class="picker-btn reasoning-btn"
                                        :class="{ active: pickerType === 'reasoning' }"
                                        title="select reasoning level"
                                        @click="pickerType = pickerType === 'reasoning' ? null : 'reasoning'"
                                    >
                                        {{ reasoningLabel }}
                                    </button>
                                    <div v-if="pickerType === 'reasoning'" class="picker-panel picker-panel-x">
                                        <div
                                            v-for="r in REASONING_LEVELS"
                                            :key="r.value"
                                            class="picker-option picker-option-x"
                                            :class="{ active: r.value === reasoningLevel }"
                                            @click="reasoningLevel = r.value; pickerType = null"
                                        >
                                            {{ r.label }}
                                        </div>
                                    </div>
                                </div>
                                <button class="send" :disabled="busy" title="发送" @click="submitPrompt">
                                    <LineIcon name="arrowUp" size="16" />
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </template>

            <template v-else-if="ui.view === 'system-settings'">
                <div class="page-card">
                    <div class="page-heading">
                        <button class="icon-btn back-btn" title="返回会话" @click="backToChat">
                            <LineIcon name="chevronRight" size="16" />
                        </button>
                        <h1>系统设置</h1>
                    </div>
                    <div class="field-row"><label>数据目录</label><input :value="cfg ? cfg.home : ''" readonly /></div>
                    <div class="field-row"><label>存储</label><input :value="cfg ? `${cfg.storage.driver} · ${cfg.storage.db}` : ''" readonly /></div>
                    <div class="field-row"><label>事件目录</label><input :value="cfg ? cfg.storage.events : ''" readonly /></div>
                    <div class="field-row"><label>Provider</label><div class="value-text">{{ cfg ? cfg.providers.join(', ') : '-' }}</div></div>
                    <div class="field-row">
                        <label>主题</label>
                        <select :value="theme" @change="setTheme($event.target.value)">
                            <option value="light">浅色</option>
                            <option value="dark">深色</option>
                            <option value="system">跟随系统</option>
                        </select>
                    </div>
                    <div class="field-row"><label>工作区</label><input :value="workspaceRoot || '（未选择）'" readonly /></div>
                    <div class="muted-block">配置保存在 ~/.mazi（providers/tools.json）。Goal 会话存储于 mazi.db（goal_nodes/goal_tasks/goal_steps）。</div>
                </div>
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

            <footer v-if="ui.view === 'chat'" class="statusbar">
                <span class="stat"><b>{{ runs.length }}</b> runs</span>
                <span class="stat"><b>{{ taskCount }}</b> tasks</span>
                <span class="stat"><b>{{ stepCount }}</b> steps</span>
                <span v-if="currentInput" class="stat input-stat">输入：{{ short(currentInput, 60) }}</span>
                <span v-if="rootOutcome" class="stat" :class="rootOutcome.ok ? 'ok' : 'fail'">
                    {{ rootOutcome.ok ? '✓ 成功' : '✗ 失败' }}
                </span>
            </footer>
        </main>

        <div
            v-if="rightOpen && !panelMaximized"
            class="panel-resizer"
            title="拖拽调整宽度"
            @pointerdown="startResize"
        ></div>
        <aside
            class="right-panel"
            :class="{ open: ui.rightOpen, maximized: panelMaximized }"
            :style="panelMaximized ? {} : { width: rightWidth + 'px', minWidth: rightWidth + 'px' }"
        >
            <div class="right-panel-inner">
                <div class="drawer-head">
                    <div class="drawer-tabs">
                        <button :class="{ on: drawerTab === 'log' }" @click="drawerTab = 'log'">日志</button>
                        <button :class="{ on: drawerTab === 'events' }" @click="drawerTab = 'events'">事件</button>
                    </div>
                    <div class="drawer-head-actions">
                        <button class="icon-btn" :title="panelMaximized ? '还原' : '最大化'" @click="togglePanelMax">
                            <LineIcon :name="panelMaximized ? 'minimize' : 'maximize'" size="14" />
                        </button>
                        <button class="icon-btn" title="收起" @click="ui.rightOpen = false">
                            <LineIcon name="close" size="15" />
                        </button>
                    </div>
                </div>

                <div v-if="drawerTab === 'log'" class="drawer-body">
                    <div v-if="current" class="exec-log">
                        <div v-if="rootOutcome" class="log-result" :class="rootOutcome.ok ? 'ok' : 'fail'">
                            <div class="log-line">
                                <span class="log-tag">{{ rootOutcome.ok ? '成功' : '失败' }}</span>
                                <span class="log-reason">reason: {{ rootOutcome.reason || '-' }}</span>
                            </div>
                            <div class="log-msg">{{ rootOutcome.ok ? rootOutcome.finalMessage : rootOutcome.errorMessage }}</div>
                        </div>
                        <div v-if="busy && !rootOutcome" class="empty-hint">执行中…（流式步骤实时到达）</div>

                        <template v-if="stepEventRows.length">
                            <div class="log-head">
                                <span>步骤（{{ stepEventRows.length }}）</span>
                                <span class="log-head-total">
                                    总耗时 {{ formatDuration(stepEventRows.reduce((s, r) => s + (r.durationMs || 0), 0)) }}
                                </span>
                            </div>
                            <div v-for="line in stepEventRows" :key="line.key" class="kanban-card" :class="`kanban-${line.kind}`">
                                <div class="kanban-head">
                                    <span class="kanban-kind">{{ line.kindLabel }}</span>
                                    <span class="kanban-status" :class="line.status">{{ line.statusLabel }}</span>
                                    <span class="kanban-time">{{ line.time }}</span>
                                    <span v-if="line.duration" class="kanban-duration">{{ line.duration }}</span>
                                </div>
                                <div v-if="line.toolName" class="kanban-tool">{{ line.toolName }}</div>
                                <pre v-if="line.text" class="kanban-content">{{ line.text }}</pre>
                                <div v-if="usageStats(line.usage)?.hasData" class="kanban-usage">
                                    <div class="usage-row">
                                        <span class="usage-label">tokens</span>
                                        <span class="usage-value">{{ usageStats(line.usage).total }}</span>
                                        <span class="usage-breakdown">
                                            in {{ usageStats(line.usage).input }} · out {{ usageStats(line.usage).output }}
                                            <template v-if="usageStats(line.usage).cache"> · cache {{ usageStats(line.usage).cache }}</template>
                                            <template v-if="usageStats(line.usage).reasoning"> · reasoning {{ usageStats(line.usage).reasoning }}</template>
                                        </span>
                                    </div>
                                    <div v-if="usageStats(line.usage).context != null" class="usage-row">
                                        <span class="usage-label">context</span>
                                        <span class="usage-value">{{ usageStats(line.usage).context }}</span>
                                    </div>
                                </div>
                            </div>
                        </template>
                        <div v-else-if="!busy" class="empty-hint">暂无步骤事件</div>
                    </div>
                    <div v-else class="empty-hint">选择一个 Goal run 后在此查看执行日志</div>
                </div>

                <div v-else class="drawer-body">
                    <div class="drawer-tabs sub">
                        <select v-model="ui.eventTypes" title="事件类型">
                            <option v-for="t in eventTypes" :key="t" :value="t">{{ t }}</option>
                        </select>
                        <button class="ev-toggle" :class="{ on: showAllEvents }" @click="showAllEvents = !showAllEvents">
                            {{ showAllEvents ? '全部' : '仅关键' }}
                        </button>
                    </div>
                    <div class="event-log">
                        <div v-for="e in filteredEvents" :key="e.eventId" class="event-row">
                            <span class="ev-dot" :class="eventColorClass(e.type)"></span>
                            <span class="event-time">{{ fmtClock(e.timestamp) }}</span>
                            <span class="event-type" :class="eventColorClass(e.type)">{{ e.type }}</span>
                            <span class="event-summary" :title="eventSummary(e)">{{ eventSummary(e) }}</span>
                        </div>
                        <div v-if="!filteredEvents.length" class="empty-hint">
                            {{ showAllEvents ? '暂无事件' : '暂无关键事件（切换「全部」查看 step 等细节）' }}
                        </div>
                    </div>
                </div>
            </div>
        </aside>
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

    <div v-if="confirmDialog.open" class="modal-mask" @click.self="cancelConfirm">
        <div class="modal confirm-modal">
            <h1>{{ confirmDialog.title }}</h1>
            <p class="confirm-message">{{ confirmDialog.message }}</p>
            <div class="modal-actions">
                <button class="ghost" @click="cancelConfirm">取消</button>
                <button :class="confirmDialog.danger ? 'danger' : 'primary'" @click="runConfirmAction">{{ confirmDialog.confirmText }}</button>
            </div>
        </div>
    </div>
</template>

<style>
.new-session {
    width: 100%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
}
.sidebar-new {
    padding: 2px 0 8px;
}
.goal-conv-head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 10px 14px 2px;
    flex-wrap: wrap;
}
.goal-conv-title {
    font-weight: 600;
    font-size: 15px;
}
.goal-conv-ws {
    color: var(--fg-secondary);
    font-size: 12px;
}
.goal-conv-meta {
    margin-left: auto;
    color: var(--fg-secondary);
    font-size: 12px;
}
.goal-runsbar {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    padding: 8px 14px 4px;
    border-bottom: 1px solid var(--border-soft);
}
.goal-chip {
    display: inline-flex;
    flex-direction: column;
    align-items: flex-start;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-panel);
    padding: 5px 12px;
    cursor: pointer;
    color: var(--fg);
    max-width: 200px;
    transition: all 0.12s;
}
.goal-chip:hover {
    border-color: var(--accent);
    background: var(--accent-soft);
}
.goal-chip.on {
    border-color: var(--accent);
    background: var(--accent);
    color: #fff;
}
.goal-chip.on .goal-chip-sub {
    color: rgba(255, 255, 255, 0.75);
}
.goal-chip-main {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 180px;
    font-size: 12px;
    font-weight: 500;
}
.goal-chip-sub {
    color: var(--fg-tertiary);
    font-size: 10px;
}
.run-block {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-bottom: 24px;
}
.msg {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-width: 100%;
    width: 100%;
}
.msg-user {
    align-items: flex-end;
}
.msg-assistant {
    align-items: stretch;
}
.msg-bubble {
    padding: 10px 14px;
    border-radius: var(--radius-lg);
    font-size: 14px;
    line-height: 1.6;
    word-break: break-word;
}
/* 用户消息：自适应宽度浅灰框，最大 85% */
.msg-user .msg-bubble {
    background: var(--bg-code);
    color: var(--fg);
    border: 1px solid var(--border-soft);
    max-width: 85%;
    width: fit-content;
}
/* AI 回答：无背景纯文本 */
.msg-assistant .msg-bubble {
    background: transparent;
    border: none;
    box-shadow: none;
    padding: 0;
}
.msg-assistant .msg-bubble.fail {
    color: var(--error);
}
.msg-bubble-head {
    font-size: 11px;
    font-weight: 600;
    color: var(--fg-tertiary);
    margin-bottom: 4px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}
.msg-final {
    margin: 0;
    white-space: pre-wrap;
    font-family: inherit;
    font-size: 14px;
    line-height: 1.65;
}
.msg-time {
    font-size: 10px;
    color: var(--fg-tertiary);
    padding: 0 2px;
}
.msg-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 4px;
}
.msg-assistant .msg-meta {
    justify-content: flex-start;
}
.msg-user .msg-time {
    align-self: flex-end;
}
.msg-feedback {
    display: flex;
    gap: 2px;
    opacity: 0;
    transition: opacity 0.12s;
}
.msg-assistant:hover .msg-feedback {
    opacity: 1;
}
.fb-btn {
    display: inline-grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--fg-tertiary);
    cursor: pointer;
    padding: 0;
}
.fb-btn:hover {
    background: var(--bg-hover);
    color: var(--accent);
}
.thinking-bubble {
    color: var(--fg-tertiary);
    font-style: italic;
    font-size: 13px;
    animation: pulse 1.5s infinite;
    padding: 4px 0;
}
.run-expand {
    display: flex;
    justify-content: center;
    padding: 4px 0;
}
.run-expand .ghost {
    font-size: 12px;
    color: var(--fg-tertiary);
}
.run-expand .ghost:hover {
    color: var(--accent);
}
.worked-for {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
    cursor: pointer;
    color: var(--fg-tertiary);
    font-size: 12px;
    user-select: none;
}
.worked-for:hover {
    color: var(--fg-secondary);
}
.worked-for-line {
    flex: 1;
    height: 1px;
    background: var(--border);
}
.worked-for-text {
    white-space: nowrap;
    font-weight: 500;
}
/* ---------- Execution stream (goal → task → step) ---------- */
.exec-stream {
    display: flex;
    flex-direction: column;
    gap: 0;
    margin: 4px 0;
}
.exec-goal {
    margin-bottom: 6px;
    position: relative;
    border-left: 2px solid var(--border);
}
.exec-goal-head {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px 4px 14px;
    cursor: pointer;
    border-radius: var(--radius-sm);
    font-size: 13px;
    font-weight: 600;
    color: var(--fg);
    user-select: none;
}
.exec-goal-head:hover {
    background: var(--bg-hover);
}
.exec-goal-tag {
    font-family: ui-monospace, monospace;
    font-size: 11px;
    font-weight: 700;
    color: var(--accent);
    background: var(--accent-soft);
    padding: 1px 5px;
    border-radius: 4px;
    flex-shrink: 0;
}
.exec-goal-title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.exec-goal-count {
    font-size: 10px;
    color: var(--fg-tertiary);
    font-weight: 400;
    flex-shrink: 0;
}
.exec-goal-body {
    padding-left: 14px;
}
.exec-task {
    margin: 4px 0;
    position: relative;
    border-left: 2px solid var(--border);
}
.exec-task-head {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px 3px 14px;
    cursor: pointer;
    border-radius: var(--radius-sm);
    font-size: 12px;
    color: var(--fg-secondary);
    user-select: none;
}
.exec-task-head:hover {
    background: var(--bg-hover);
}
.exec-task-tag {
    font-family: ui-monospace, monospace;
    font-size: 10px;
    font-weight: 700;
    color: var(--thinking);
    background: var(--thinking-soft);
    padding: 1px 4px;
    border-radius: 3px;
    flex-shrink: 0;
}
.exec-task-title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.exec-task-count {
    font-size: 10px;
    color: var(--fg-tertiary);
    flex-shrink: 0;
}
.exec-task-body {
    padding-left: 14px;
}
/* ---------- Collapsible dot (default circle, hover → +/- button) ---------- */
.exec-dot {
    position: absolute;
    left: -5px;
    top: 50%;
    transform: translateY(-50%);
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--bg);
    border: 2px solid var(--fg-tertiary);
    box-sizing: border-box;
    cursor: default;
    display: grid;
    place-items: center;
    font-size: 10px;
    font-weight: 700;
    line-height: 1;
    color: transparent;
    transition: all 0.12s ease;
    z-index: 2;
}
.exec-dot.interactive {
    cursor: pointer;
}
.exec-dot::after {
    content: '−';
}
.exec-dot.collapsed::after {
    content: '+';
}
.goal-dot { border-color: var(--accent); }
.task-dot { border-color: var(--thinking); }
.exec-goal-head:hover .exec-dot,
.exec-task-head:hover .exec-dot {
    width: 16px;
    height: 16px;
    left: -9px;
    border-radius: 4px;
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
}
.exec-task-head:hover .exec-dot {
    background: var(--thinking);
    border-color: var(--thinking);
}
.exec-step {
    display: flex;
    flex-direction: column;
    gap: 3px;
    position: relative;
    border-left: 2px solid var(--border);
}
.exec-step-head {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 8px 0 14px;
    height: 22px; /* 4px visual pad + 14px icon + 4px visual pad */
    box-sizing: border-box;
    font-size: 12px;
    line-height: 1;
    color: var(--fg-secondary);
    border-radius: var(--radius-sm);
}
.exec-step-head > * {
    margin-top: 0;
    margin-bottom: 0;
}
.exec-step-head .line-icon {
    display: block;
    flex-shrink: 0;
    color: var(--fg-tertiary);
}
.exec-step-head.clickable {
    cursor: pointer;
}
.exec-step-head.clickable:hover {
    background: var(--bg-hover);
}
.exec-thinking .exec-step-head .line-icon { color: var(--thinking); }
.exec-tool_call .exec-step-head .line-icon { color: var(--tool); }
.exec-observation .exec-step-head .line-icon { color: var(--observation); }
.exec-step.error .exec-step-head .line-icon { color: var(--error); }

.exec-step-name {
    font-weight: 600;
    font-size: 12px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    color: var(--fg);
    flex-shrink: 0;
}
.exec-step-tag {
    font-family: ui-monospace, monospace;
    font-size: 10px;
    font-weight: 700;
    color: var(--fg-tertiary);
    background: var(--bg-code);
    padding: 1px 4px;
    border-radius: 3px;
    flex-shrink: 0;
}
.exec-thinking .exec-step-name { color: var(--thinking); }
.exec-tool_call .exec-step-name { color: var(--tool); }
.exec-observation .exec-step-name { color: var(--observation); }
.exec-step.error .exec-step-name { color: var(--error); }
.exec-step-summary {
    font-size: 12px;
    color: var(--fg-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 80%;
    flex: 1 1 auto;
    min-width: 0;
}
.exec-step.error .exec-step-summary {
    color: var(--error);
}
.exec-step-duration {
    font-size: 10px;
    color: var(--fg-tertiary);
    font-family: ui-monospace, monospace;
    flex-shrink: 0;
}
.exec-step-time {
    margin-left: auto;
    font-size: 10px;
    color: var(--fg-tertiary);
    font-family: ui-monospace, monospace;
    flex-shrink: 0;
}
.exec-step-code {
    background: var(--bg-code);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    margin: 2px 8px 4px 14px;
    overflow: hidden;
}
.exec-step-code-inner {
    margin: 0;
    padding: 8px 10px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    line-height: 1.5;
    color: var(--fg);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: calc(12px * 1.5 * 12 + 16px); /* 12 rows + padding */
    overflow: auto;
}
.exec-thinking .exec-step-code-inner {
    color: var(--fg-secondary);
    font-style: italic;
}
.exec-step.error .exec-step-code-inner {
    color: var(--error);
}
.exec-step-usage {
    font-size: 10px;
    color: var(--fg-tertiary);
    font-family: ui-monospace, monospace;
    margin: 0 8px 2px 14px;
}
/* step dot: fully independent class, no .exec-dot inheritance */
.step-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    border: 2px solid var(--fg-tertiary);
    background: var(--bg);
    box-sizing: border-box;
    flex-shrink: 0;
    margin-left: -19px;
    cursor: default;
    position: relative;
}
.step-dot.interactive { cursor: pointer; }
.step-dot::after {
    content: '−';
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    font-size: 10px;
    font-weight: 700;
    color: transparent;
    line-height: 1;
}
.step-dot.collapsed::after { content: '+'; }
.exec-step.exec-thinking .step-dot { border-color: var(--thinking); }
.exec-step.exec-tool_call .step-dot { border-color: var(--tool); }
.exec-step.exec-observation .step-dot { border-color: var(--observation); }
.exec-step.error .step-dot { border-color: var(--error); }
.exec-step-head.clickable:hover .step-dot {
    width: 16px;
    height: 16px;
    margin-left: -23px;
    border-radius: 4px;
    background: var(--fg-tertiary);
    border-color: var(--fg-tertiary);
}
.exec-step-head.clickable:hover .step-dot::after { color: #fff; }
.exec-step.exec-thinking .exec-step-head.clickable:hover .step-dot { background: var(--thinking); border-color: var(--thinking); }
.exec-step.exec-tool_call .exec-step-head.clickable:hover .step-dot { background: var(--tool); border-color: var(--tool); }
.exec-step.exec-observation .exec-step-head.clickable:hover .step-dot { background: var(--observation); border-color: var(--observation); }
.exec-step.error .exec-step-head.clickable:hover .step-dot { background: var(--error); border-color: var(--error); }
.exec-stats {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 4px 4px;
    font-size: 11px;
    color: var(--fg-tertiary);
    font-family: ui-monospace, monospace;
}

.goal-card {
    border: 1px solid var(--border);
    border-left: 3px solid var(--fg-tertiary);
    border-radius: var(--radius);
    background: var(--bg-panel);
    padding: 12px 14px;
    margin: 0 14px 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    box-shadow: var(--shadow-sm);
}
.goal-card.goal-kind-intake { border-left-color: var(--accent); }
.goal-card.goal-kind-work { border-left-color: var(--thinking); }
.kind-pill {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 2px 8px;
    border-radius: 4px;
    background: var(--bg-code);
    color: var(--fg-secondary);
}
.kind-pill.intake { background: var(--accent-soft); color: var(--accent-text); }
.kind-pill.work { background: var(--thinking-soft); color: var(--thinking); }
.status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--fg-tertiary);
    flex-shrink: 0;
}
.status-dot.ok { background: var(--ok); }
.status-dot.error, .status-dot.failed { background: var(--error); }
.status-dot.running, .status-dot.active { background: var(--accent); animation: pulse 1.5s infinite; }
.status-dot.pending { background: var(--warn); }
@keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
}
.status-text {
    font-size: 11px;
    color: var(--fg-secondary);
}
.task-meta {
    font-size: 11px;
    color: var(--fg-tertiary);
    margin-left: auto;
}
.goal-head,
.goal-task-head {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
}
.goal-statement {
    flex: 1;
    min-width: 0;
    font-weight: 500;
}
.goal-task {
    border-top: 1px solid var(--border-soft);
    padding-top: 8px;
}
.goal-task-title {
    color: var(--fg-secondary);
    font-size: 13px;
}
.goal-steps {
    list-style: none;
    margin: 6px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
}
.step-item {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    font-size: 13px;
    padding: 5px 8px;
    border-radius: var(--radius-sm);
    transition: background 0.12s;
}
.step-item:hover {
    background: var(--bg-hover);
}
.step-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    margin-top: 6px;
    flex-shrink: 0;
    background: var(--fg-tertiary);
}
.step-thinking .step-dot { background: var(--thinking); }
.step-tool_call .step-dot { background: var(--tool); }
.step-observation .step-dot { background: var(--observation); }
.step-kind {
    width: 36px;
    flex-shrink: 0;
    font-size: 11px;
    color: var(--fg-secondary);
    margin-top: 1px;
}
.step-thinking .step-kind { color: var(--thinking); }
.step-tool_call .step-kind { color: var(--tool); }
.step-observation .step-kind { color: var(--observation); }
.step-status {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 4px;
    flex-shrink: 0;
    margin-top: 1px;
    background: var(--bg-code);
    color: var(--fg-secondary);
}
.step-status.ok { background: var(--ok-soft); color: var(--ok); }
.step-status.error, .step-status.failed { background: var(--error-soft); color: var(--error); }
.step-status.running, .step-status.active { background: var(--accent-soft); color: var(--accent); }
.step-content {
    flex: 1;
    min-width: 0;
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
}
.step-when {
    color: var(--fg-tertiary);
    font-size: 11px;
    flex-shrink: 0;
    margin-top: 1px;
}
.goal-bubble {
    border: 1px solid var(--border);
    background: var(--user-bubble);
    border-radius: 10px;
    padding: 10px 12px;
    margin: 0 14px 10px;
}
.goal-bubble-head {
    color: var(--fg-secondary);
    font-size: 12px;
    margin-bottom: 4px;
}
.goal-final {
    white-space: pre-wrap;
    margin: 0;
    font-family: inherit;
}
.ok-banner {
    margin: 0 14px 6px;
}
.badge.new {
    border-color: var(--warn);
    color: var(--warn);
}
.badge.goal {
    border-color: var(--accent);
    color: var(--accent);
}
.badge.active,
.badge.pending {
    border-color: var(--accent);
    color: var(--accent);
}
.badge.succeeded {
    border-color: var(--ok);
    color: var(--ok);
}
.badge.failed {
    border-color: var(--error);
    color: var(--error);
}
.badge.taskid {
    font-family: ui-monospace, monospace;
}
.stat.ok {
    color: var(--ok);
}
.stat.fail {
    color: var(--error);
}

/* 会话区头部 ＋ 与编辑一致：hover 才显示 */
.sidebar .group-head .head-icons {
    opacity: 0;
    transition: opacity 0.15s ease;
}
.sidebar .group-head:hover .head-icons {
    opacity: 1;
}


.exec-log {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
}
.log-result {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px 8px;
    margin-bottom: 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
}
.log-result.ok {
    border-color: var(--ok);
}
.log-result.fail {
    border-color: var(--error);
}
.log-line {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
}
.log-tag {
    font-weight: 600;
    color: var(--fg);
}
.log-result.ok .log-tag {
    color: var(--ok);
}
.log-result.fail .log-tag {
    color: var(--error);
}
.log-reason {
    color: var(--fg-secondary);
}
.log-msg {
    color: var(--fg);
    white-space: pre-wrap;
    word-break: break-word;
}
.log-head {
    color: var(--fg-secondary);
    text-transform: uppercase;
    font-size: 11px;
    margin: 10px 0 6px;
    display: flex;
    justify-content: space-between;
    align-items: center;
}
.log-head-total {
    text-transform: none;
    font-size: 10px;
    color: var(--fg-tertiary);
    font-weight: 500;
}

/* ---------- Kanban step cards ---------- */
.kanban-card {
    border: 1px solid var(--border);
    border-left: 3px solid var(--fg-tertiary);
    border-radius: var(--radius);
    padding: 8px 10px;
    margin-bottom: 6px;
    background: var(--bg-panel);
    transition: box-shadow 0.12s;
}
.kanban-card:hover {
    box-shadow: var(--shadow-sm);
}
.kanban-card.kanban-thinking { border-left-color: var(--thinking); }
.kanban-card.kanban-tool_call { border-left-color: var(--tool); }
.kanban-card.kanban-observation { border-left-color: var(--observation); }

.kanban-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
}
.kanban-kind {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--bg-code);
    color: var(--fg-secondary);
}
.kanban-thinking .kanban-kind { background: var(--thinking-soft); color: var(--thinking); }
.kanban-tool_call .kanban-kind { background: var(--tool-soft); color: var(--tool); }
.kanban-observation .kanban-kind { background: var(--observation-soft); color: var(--observation); }

.kanban-status {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--bg-code);
    color: var(--fg-secondary);
}
.kanban-status.ok { background: var(--ok-soft); color: var(--ok); }
.kanban-status.error, .kanban-status.failed { background: var(--error-soft); color: var(--error); }
.kanban-status.running, .kanban-status.active { background: var(--accent-soft); color: var(--accent); }

.kanban-time {
    font-size: 10px;
    color: var(--fg-tertiary);
    font-family: ui-monospace, monospace;
    margin-left: auto;
}
.kanban-duration {
    font-size: 10px;
    color: var(--fg-secondary);
    font-family: ui-monospace, monospace;
    background: var(--bg-code);
    padding: 1px 5px;
    border-radius: 4px;
}

.kanban-tool {
    font-size: 12px;
    font-weight: 600;
    color: var(--tool);
    margin-bottom: 2px;
    font-family: ui-monospace, monospace;
}

.kanban-content {
    margin: 0;
    font-size: 11px;
    line-height: 1.5;
    color: var(--fg);
    background: var(--bg-code);
    border-radius: var(--radius-sm);
    padding: 6px 8px;
    max-height: 120px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.kanban-usage {
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px solid var(--border-soft);
    display: flex;
    flex-direction: column;
    gap: 3px;
}
.usage-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 10px;
}
.usage-label {
    color: var(--fg-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.4px;
    width: 48px;
    flex-shrink: 0;
}
.usage-value {
    font-weight: 600;
    color: var(--fg);
    font-family: ui-monospace, monospace;
    min-width: 40px;
}
.usage-breakdown {
    color: var(--fg-secondary);
    font-family: ui-monospace, monospace;
    font-size: 10px;
}
.log-row {
    display: flex;
    gap: 8px;
    align-items: center;
    border-bottom: 1px dashed var(--border);
    padding: 2px 0;
}
.log-time {
    color: var(--trace-text);
    font-size: 11px;
}
.log-kind {
    min-width: 34px;
}
.log-kind.thinking {
    color: var(--accent);
}
.log-kind.tool_call {
    color: var(--warn);
}
.log-kind.observation {
    color: var(--ok);
}
.log-status.ok,
.log-status.succeeded {
    color: var(--ok);
}
.log-status.failed,
.log-status.error,
.log-status.blocked {
    color: var(--error);
}
.log-id {
    color: var(--fg-secondary);
    font-family: ui-monospace, monospace;
    font-size: 11px;
    margin-left: auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 130px;
}
.log-row {
    flex-wrap: wrap;
}
.log-detail {
    flex-basis: 100%;
    color: var(--fg-secondary);
    font-size: 11px;
    font-family: ui-monospace, monospace;
    white-space: pre-wrap;
    word-break: break-word;
    padding-left: 4px;
}

.goal-bubble.fail {
    border-color: var(--error);
}
/* 右侧栏拖拽调宽手柄 */
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

/* 步骤行：头部 + 代码块内容 */
.exec-log .log-row {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 3px;
    padding: 6px 2px;
    border-bottom: 1px dashed var(--border);
}
.log-row-head {
    display: flex;
    gap: 8px;
    align-items: center;
}
.log-code {
    margin: 0;
    padding: 6px 8px;
    border-radius: 6px;
    background: var(--bg-code);
    border: 1px solid var(--border);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    overflow-y: auto;
    max-height: calc(1.5em * 10 + 12px); /* 约 10 行竖向滚动窗口 */
}

.log-usage {
    color: var(--accent);
    font-size: 11px;
    font-family: ui-monospace, monospace;
}
</style>
