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
const searchOpen = ref(false);
const projectCollapsed = ref({});
const projectMenuFor = ref('');
const accountOpen = ref(false);
const selectedModel = ref('');
const feedbackSent = ref(false);
const feedbackModal = ref(false);
const feedbackRating = ref(5);
const feedbackContent = ref('');
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
const archivedConversations = computed(() =>
    conversations.value.filter((c) => c.archived === true),
);
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

async function submitNew(exec) {
    await createAndRunGoal(
        {
            statement: draft.value.statement,
            permissionCeiling: draft.value.permission,
            maxCostUsd: draft.value.budgetUsd,
            maxSteps: draft.value.maxSteps,
            userId: draft.value.userId || undefined,
            loopMode: draft.value.loopMode,
        },
        workspaceRoot.value,
        currentConversation.value || undefined,
        exec,
    );
    draft.value.statement = '';
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

async function setConversationArchived(conversation, archived) {
    await updateConversation(conversation.conversationId, { archived });
}

async function removeConversation(conversation) {
    if (
        !window.confirm(
            `删除会话「${conversationTitle(conversation)}」？此操作同时删除其 Goal 树。`,
        )
    ) {
        return;
    }
    await deleteConversationById(conversation.conversationId);
}

async function renameProjectById(project) {
    const title = window.prompt('重命名项目', project.title);
    if (title?.trim()) {
        await renameProject(project.path, title.trim());
    }
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

const filteredEvents = computed(() => {
    const key = ui.eventTypes === 'all' ? null : ui.eventTypes;
    const list = key ? events.list.filter((e) => e.type === key) : events.list;
    return list.slice().reverse();
});
const eventTypes = computed(() => [
    'all',
    ...new Set(events.list.map((e) => e.type)),
]);

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
                <button class="primary new-session" @click="ui.showNew = true">
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
                                    <button title="归档会话" @click.stop="setConversationArchived(c, true)"><LineIcon name="archive" size="13" /></button>
                                    <button title="删除会话" @click.stop="removeConversation(c)"><LineIcon name="trash" size="13" /></button>
                                </div>
                                <div class="session-meta">
                                    <span class="badge" :class="badge(conversationOutcome(c))">{{ conversationOutcome(c) }}</span>
                                    <span>{{ (c.runs || []).length }} runs</span>
                                    <span class="time">{{ relTime(c.updatedAt || c.createdAt) }}</span>
                                </div>
                            </li>
                            <li v-if="!projectConversationItems(project).length" class="empty-sidebar">
                                暂无项目会话
                            </li>
                        </template>
                    </ul>
                </div>
                <div class="group">
                    <div class="group-head">会话 · {{ generalConversations.length }}</div>
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
                                <button title="归档会话" @click.stop="setConversationArchived(c, true)"><LineIcon name="archive" size="13" /></button>
                                <button title="删除会话" @click.stop="removeConversation(c)"><LineIcon name="trash" size="13" /></button>
                            </div>
                            <div class="session-meta">
                                <span class="badge" :class="badge(conversationOutcome(c))">{{ conversationOutcome(c) }}</span>
                                <span>{{ (c.runs || []).length }} runs</span>
                                <span class="time">{{ relTime(c.updatedAt || c.createdAt) }}</span>
                            </div>
                        </li>
                        <li v-if="!generalConversations.length" class="empty-sidebar">暂无会话</li>
                    </ul>
                </div>
                <div class="group">
                    <div class="group-head">已归档 · {{ archivedConversations.length }}</div>
                    <ul class="session-list">
                        <li
                            v-for="c in archivedConversations"
                            :key="c.conversationId"
                            :class="{ active: isConversationActive(c) }"
                            @click="openConversation(c)"
                        >
                            <div class="session-title">{{ conversationTitle(c) }}</div>
                            <div class="session-actions">
                                <button title="重命名会话" @click.stop="renameConversationById(c)"><LineIcon name="rename" size="13" /></button>
                                <button title="恢复会话" @click.stop="setConversationArchived(c, false)"><LineIcon name="restore" size="13" /></button>
                                <button title="删除会话" @click.stop="removeConversation(c)"><LineIcon name="trash" size="13" /></button>
                            </div>
                            <div class="session-meta">
                                <span class="time">{{ relTime(c.updatedAt || c.createdAt) }}</span>
                            </div>
                        </li>
                        <li v-if="!archivedConversations.length" class="empty-sidebar">暂无归档</li>
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
                        <span class="goal-conv-meta">{{ runs.length }} runs · {{ activeGoals.length }} goals · {{ taskCount }} tasks · {{ stepCount }} steps</span>
                    </div>
                    <div class="goal-runsbar">
                        <button
                            v-for="(run, i) in runs"
                            :key="run.rootGoalId"
                            class="goal-chip"
                            :class="{ on: run.rootGoalId === current }"
                            @click="selectRun(run)"
                        >
                            <span class="goal-chip-main">{{ i + 1 }} · {{ runLabel(run) }}</span>
                            <span class="goal-chip-sub">
                                {{ fmtClock(run.createdAt) }}
                                <template v-if="runOutcomes[run.rootGoalId]">
                                    · {{ runOutcomes[run.rootGoalId].ok ? '✓' : '✗' }}
                                </template>
                            </span>
                        </button>
                        <button v-if="!runs.length" class="goal-chip-add" @click="ui.showNew = true">＋ 追加任务</button>
                    </div>
                </template>

                <div class="chat-scroll">
                    <template v-if="activeConversation && detail">
                        <div v-if="rootOutcome?.finalMessage" class="goal-bubble">
                            <div class="goal-bubble-head">最终回答</div>
                            <pre class="goal-final">{{ rootOutcome.finalMessage }}</pre>
                        </div>
                        <div v-if="feedbackSent" class="ok-banner">反馈已记录</div>
                        <div v-for="goal in activeGoals" :key="goal.goalId" class="goal-card">
                            <div class="goal-head">
                                <span class="badge" :class="goal.kind">{{ goal.kind }}</span>
                                <span class="badge" :class="statusClass(goal.status)">{{ statusLabel(goal.status) }}</span>
                                <span class="goal-statement">{{ goal.statement }}</span>
                            </div>
                            <div v-for="task in goal.tasks" :key="task.taskId" class="goal-task">
                                <div class="goal-task-head">
                                    <span class="badge taskid" :title="task.taskId">{{ short(task.taskId, 24) }}</span>
                                    <span class="badge" :class="statusClass(task.status)">{{ statusLabel(task.status) }}</span>
                                    <span class="goal-task-title">{{ task.title }}</span>
                                </div>
                                <ul v-if="task.steps.length" class="goal-steps">
                                    <li v-for="step in task.steps" :key="step.stepId">
                                        <span class="goal-glyph">{{ kindGlyph(step.kind) }}</span>
                                        <span class="goal-step-kind">{{ statusLabel(step.kind) }}</span>
                                        <span class="badge" :class="statusClass(step.status)">{{ statusLabel(step.status) }}</span>
                                        <span class="goal-step-id" :title="step.stepId">{{ short(step.stepId, 32) }}</span>
                                        <span class="goal-when">{{ fmtClock(step.startedAt) }}</span>
                                    </li>
                                </ul>
                                <div v-else class="empty-hint">（该 Task 尚无 Step）</div>
                            </div>
                        </div>
                    </template>
                    <div v-else-if="activeConversation" class="empty-hint">
                        暂无 Goal 树（run 不存在或已被删除）。
                    </div>
                    <div v-else class="empty-hint">暂无会话，点击「新会话」开始</div>
                </div>

                <div class="input-area">
                    <button class="icon-btn add-btn" title="选择/创建工作区" @click="openSystemPicker">
                        <LineIcon name="plus" size="17" />
                    </button>
                    <textarea
                        v-model="prompt"
                        rows="1"
                        placeholder="输入任务…（Enter 发送，Shift+Enter 换行）"
                        @keydown.enter.exact.prevent="submitPrompt"
                    ></textarea>
                    <div class="input-actions">
                        <select v-model="selectedModel" title="模型">
                            <option v-for="m in modelOptions" :key="m.id" :value="m.id">{{ m.label }}</option>
                        </select>
                        <select v-model="draft.loopMode" class="mode-select" title="Loop 模式">
                            <option v-for="m in LOOP_MODE_OPTIONS" :key="m.value" :value="m.value">
                                {{ m.label }}
                            </option>
                        </select>
                        <button v-if="current" class="ghost" title="重跑当前 Goal" @click="rerunCurrent">
                            <LineIcon name="refresh" size="15" />
                        </button>
                        <button v-if="current && rootOutcome" class="ghost" title="评分" @click="openRate">
                            <LineIcon name="like" size="15" />
                        </button>
                        <button class="send" :disabled="busy" title="发送" @click="submitPrompt">
                            <LineIcon name="send" size="16" />
                        </button>
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

        <aside class="right-panel" :class="{ open: ui.rightOpen }">
            <div class="right-panel-inner">
                <div class="drawer-head">
                    <div class="drawer-tabs">
                        <button :class="{ on: true }">事件</button>
                    </div>
                    <button class="icon-btn" title="收起" @click="ui.rightOpen = false">
                        <LineIcon name="close" size="15" />
                    </button>
                </div>
                <div class="drawer-body">
                    <div class="drawer-tabs sub">
                        <select v-model="ui.eventTypes" title="事件类型">
                            <option v-for="t in eventTypes" :key="t" :value="t">{{ t }}</option>
                        </select>
                    </div>
                    <div class="event-log">
                        <div v-for="e in filteredEvents" :key="e.eventId" class="event-row">
                            <span class="event-time">{{ fmtClock(e.timestamp) }}</span>
                            <span class="event-type">{{ e.type }}</span>
                            <span class="event-ids">{{ short(e.sessionId, 16) }}</span>
                        </div>
                        <div v-if="!filteredEvents.length" class="empty-hint">暂无事件</div>
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
    padding: 6px 14px 4px;
}
.goal-chip {
    display: inline-flex;
    flex-direction: column;
    align-items: flex-start;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-panel);
    padding: 4px 10px;
    cursor: pointer;
    color: var(--fg);
    max-width: 260px;
}
.goal-chip.on {
    border-color: var(--accent);
    background: var(--bg-active);
}
.goal-chip-main {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 240px;
    font-size: 13px;
}
.goal-chip-sub {
    color: var(--fg-secondary);
    font-size: 11px;
}
.goal-card {
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg-panel);
    padding: 10px 12px;
    margin: 0 14px 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
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
}
.goal-task {
    border-top: 1px dashed var(--border);
    padding-top: 6px;
}
.goal-task-title {
    color: var(--fg-secondary);
}
.goal-steps {
    list-style: none;
    margin: 4px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
}
.goal-steps li {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 13px;
}
.goal-glyph {
    width: 18px;
}
.goal-step-kind {
    width: 90px;
}
.goal-step-id {
    color: var(--fg-secondary);
    font-family: ui-monospace, monospace;
    font-size: 11px;
}
.goal-when {
    color: var(--trace-text);
    font-size: 11px;
    margin-left: auto;
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
</style>
