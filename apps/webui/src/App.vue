<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import {
    activeConversations,
    defaultConversations,
    projectConversations,
} from './sidebar.js';
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
    openConversation,
    openRun,
    pickWorkspace,
    projects,
    relTime,
    renameProject,
    runOutcomes,
    sendFeedback,
    setTheme,
    short,
    statusLabel,
    stopEvents,
    theme,
    ui,
    updateConversation,
    workspaceRoot,
} from './store.js';

const search = ref('');
const newText = ref('');
const newUser = ref('');
const showSettings = ref(false);
const settingsTab = ref('config');
const renameDraft = reactive({ title: '' });
const feedback = reactive({ open: false, rating: 0, content: '' });
const rightOpen = ref(false);
const composerEl = ref(null);

const THEME_CYCLE = ['light', 'dark', 'system'];

function cycleTheme() {
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(theme.value) + 1) % THEME_CYCLE.length];
    setTheme(next);
}

const filteredConversations = computed(() => {
    const key = search.value.trim().toLowerCase();
    if (!key) {
        return conversations.value;
    }
    return conversations.value.filter(
        (c) =>
            c.title.toLowerCase().includes(key) ||
            (c.runs || []).some((r) => r.input.toLowerCase().includes(key)),
    );
});

const defaultList = computed(() => defaultConversations(filteredConversations.value));
const archivedList = computed(() => filteredConversations.value.filter((c) => c.archived === true));

const projectList = computed(() =>
    projects.value
        .map((p) => ({
            title: p.title,
            path: p.path,
            items: projectConversations(filteredConversations.value, p.path, p.path),
        }))
        .filter((group) => group.items.length > 0),
);

const activeConversation = computed(() =>
    conversations.value.find((c) => c.conversationId === currentConversation.value),
);

const runs = computed(() => activeConversation.value?.runs || []);
const activeGoals = computed(() => detail.value?.goals || []);
const taskCount = computed(() => detail.value?.taskCount ?? 0);
const stepCount = computed(() => detail.value?.stepCount ?? 0);
const rootOutcome = computed(() => (current.value ? runOutcomes[current.value] : null));

function runTitle(run) {
    return short(run.input, 60) || run.rootGoalId;
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

async function chooseConversation(c) {
    await openConversation(c.conversationId);
}

function startNew() {
    currentConversation.value = null;
    current.value = null;
    detail.value = null;
    stopEvents();
    newText.value = '';
    newUser.value = '';
    appendNew();
}

async function appendNew() {
    ui.showNew = true;
    await nextTick();
    composerEl.value?.focus();
}

async function submitNewRun() {
    const input = newText.value.trim();
    if (!input || busy.value) return;
    newText.value = '';
    await createRun({
        input,
        userId: newUser.value || undefined,
        workspacePath: workspaceRoot.value || undefined,
        conversationId: currentConversation.value ?? undefined,
        exec: true,
    });
}

async function rerunActive() {
    await executeRun(current.value);
}

async function saveTitle() {
    const title = renameDraft.title.trim();
    if (title && activeConversation.value) {
        await updateConversation(activeConversation.value.conversationId, { title });
    }
    renameDraft.title = '';
}

async function toggleArchive() {
    if (!activeConversation.value) return;
    await updateConversation(activeConversation.value.conversationId, {
        archived: activeConversation.value.archived ? false : true,
    });
}

async function removeConversation() {
    if (!activeConversation.value) return;
    if (!window.confirm('删除该会话（含其 Goal 树）？')) return;
    await deleteConversationById(activeConversation.value.conversationId);
}

async function promptRenameProject(group) {
    const title = window.prompt('项目名', group.title);
    if (title && title.trim()) {
        await renameProject(group.path, title.trim());
    }
}

function startFeedback() {
    const outcome = rootOutcome.value;
    feedback.open = true;
    feedback.rating = outcome?.ok ? 5 : 3;
    feedback.content = '';
}

async function submitFeedback() {
    if (!current.value) return;
    await sendFeedback(current.value, feedback.rating, feedback.content);
    feedback.open = false;
}

const visibleEvents = computed(() => {
    const key = events.types === 'all' ? null : events.types;
    return key ? events.list.filter((e) => e.type === key) : events.list;
});
const eventTypesAvailable = computed(() => [...new Set(events.list.map((e) => e.type))]);

function eventTypeClass(type) {
    if (type === 'session.started' || type === 'session.ended') return 'succeeded';
    if (type === 'user.feedback.captured') return 'warn';
    return '';
}

onMounted(async () => {
    await Promise.all([loadConfig(), loadConversations(), loadWorkspace()]);
    const first = activeConversations(conversations.value).sort(
        (a, b) => b.updatedAt - a.updatedAt,
    )[0];
    if (first) {
        await openConversation(first.conversationId);
    }
});

onBeforeUnmount(() => {
    stopEvents();
});
</script>

<template>
    <div class="shell">
        <aside class="sidebar" :class="{ hidden: !ui.sidebar }">
            <div class="brand">
                <strong>mazi</strong><span>Goal/Task/Step</span>
            </div>
            <button class="newbtn" @click="startNew()">＋ 新会话</button>
            <input v-model="search" class="search" placeholder="搜索会话 / 输入…" />

            <div class="groups">
                <div v-for="group in projectList" :key="group.path" class="group">
                    <div class="group-head">
                        <span>📁 {{ group.title }}</span>
                        <button class="mini" :title="group.path" @click="promptRenameProject(group)">✎</button>
                    </div>
                    <button
                        v-for="c in group.items"
                        :key="c.conversationId"
                        class="conv"
                        :class="{ on: c.conversationId === currentConversation }"
                        @click="chooseConversation(c)"
                    >
                        <span class="ctitle">{{ c.title }}</span>
                        <span class="csub">{{ (c.runs || []).length }} 次 · {{ relTime(c.updatedAt) }}</span>
                    </button>
                </div>

                <div v-if="defaultList.length" class="group">
                    <div class="group-head"><span>会话</span></div>
                    <button
                        v-for="c in defaultList"
                        :key="c.conversationId"
                        class="conv"
                        :class="{ on: c.conversationId === currentConversation }"
                        @click="chooseConversation(c)"
                    >
                        <span class="ctitle">{{ c.title }}</span>
                        <span class="csub">{{ (c.runs || []).length }} 次 · {{ relTime(c.updatedAt) }}</span>
                    </button>
                </div>

                <div v-if="archivedList.length" class="group">
                    <div class="group-head"><span>已归档</span></div>
                    <button
                        v-for="c in archivedList"
                        :key="c.conversationId"
                        class="conv"
                        @click="chooseConversation(c)"
                    >
                        <span class="ctitle">{{ c.title }}</span>
                        <span class="csub">{{ relTime(c.updatedAt) }}</span>
                    </button>
                </div>
            </div>
        </aside>

        <section class="main">
            <header class="topbar">
                <button @click="ui.sidebar = !ui.sidebar">☰</button>
                <div class="crumb">
                    <template v-if="activeConversation">
                        <span class="title">{{ activeConversation.title }}</span>
                        <span v-if="current" class="runid" :title="current">{{ short(current, 18) }}</span>
                    </template>
                    <span v-else class="title">新会话</span>
                </div>
                <div class="tools">
                    <button :title="'主题: ' + theme" @click="cycleTheme()">◐</button>
                    <button :class="{ on: rightOpen }" @click="rightOpen = !rightOpen">事件</button>
                    <button @click="showSettings = !showSettings">设置</button>
                </div>
            </header>

            <div v-if="ui.err" class="errbar">{{ ui.err }}</div>

            <div v-if="activeConversation" class="body">
                <div class="manage-row">
                    <input v-model="renameDraft.title" class="title-input" :placeholder="activeConversation.title" />
                    <button class="mini" @click="saveTitle()">改名</button>
                    <button class="mini" @click="toggleArchive()">
                        {{ activeConversation.archived ? '恢复' : '归档' }}
                    </button>
                    <button class="mini danger" @click="removeConversation()">删除</button>
                </div>

                <div class="runsbar">
                    <span class="runs-label">Goal runs</span>
                    <button
                        v-for="(run, i) in runs"
                        :key="run.rootGoalId"
                        class="chip"
                        :class="{ on: run.rootGoalId === current }"
                        @click="openRun(run.rootGoalId)"
                    >
                        <span class="chip-main">{{ i + 1 }} · {{ runTitle(run) }}</span>
                        <span class="chip-sub">
                            {{ fmtClock(run.createdAt) }}
                            <template v-if="runOutcomes[run.rootGoalId]">
                                · {{ runOutcomes[run.rootGoalId].ok ? '成功' : '失败' }}
                            </template>
                        </span>
                    </button>
                    <button class="chip add" @click="appendNew()">＋ 追加</button>
                </div>

                <div v-if="detail" class="content">
                    <div class="summary">
                        <span>Goal {{ activeGoals.length }} · Task {{ taskCount }} · Step {{ stepCount }}</span>
                        <span v-if="rootOutcome" class="outcome" :class="rootOutcome.ok ? 'ok' : 'fail'">
                            {{ rootOutcome.ok ? '成功' : '失败' }}
                        </span>
                    </div>

                    <div v-if="rootOutcome?.finalMessage" class="bubble">
                        <div class="bubble-head">最终回答</div>
                        <pre class="final">{{ rootOutcome.finalMessage }}</pre>
                    </div>

                    <div v-for="goal in activeGoals" :key="goal.goalId" class="goal-card">
                        <div class="goal-head">
                            <span class="pill" :class="goal.kind">{{ goal.kind }}</span>
                            <span class="pill" :class="statusClass(goal.status)">{{ statusLabel(goal.status) }}</span>
                            <span class="statement">{{ goal.statement }}</span>
                        </div>
                        <div v-for="task in goal.tasks" :key="task.taskId" class="task">
                            <div class="task-head">
                                <span class="pill taskid" :title="task.taskId">{{ short(task.taskId, 26) }}</span>
                                <span class="pill" :class="statusClass(task.status)">{{ statusLabel(task.status) }}</span>
                                <span class="task-title">{{ task.title }}</span>
                            </div>
                            <ul v-if="task.steps.length" class="steps">
                                <li v-for="step in task.steps" :key="step.stepId">
                                    <span class="glyph">{{ kindGlyph(step.kind) }}</span>
                                    <span class="step-kind">{{ statusLabel(step.kind) }}</span>
                                    <span class="pill" :class="statusClass(step.status)">{{ statusLabel(step.status) }}</span>
                                    <span class="step-id" :title="step.stepId">{{ short(step.stepId, 34) }}</span>
                                    <span class="when">{{ fmtClock(step.startedAt) }}</span>
                                </li>
                            </ul>
                            <div v-else class="empty">（该 Task 尚无 Step）</div>
                        </div>
                    </div>
                </div>
                <div v-else class="empty-state">没有可展示的 Goal 树（run 不存在或已被删除）。</div>

                <div class="composer">
                    <textarea
                        ref="composerEl"
                        v-model="newText"
                        rows="2"
                        placeholder="输入新的任务/问题，Enter 运行；Shift+Enter 换行"
                        @keydown.enter.exact.prevent="submitNewRun()"
                    ></textarea>
                    <div class="composer-row">
                        <input v-model="newUser" class="user" placeholder="userId（可选）" />
                        <button :disabled="busy || !newText.trim()" @click="submitNewRun()">
                            {{ busy ? '运行中…' : '运行' }}
                        </button>
                        <button v-if="current" :disabled="busy" @click="rerunActive()">重跑当前</button>
                        <button v-if="current && !rootOutcome" :disabled="busy" @click="executeRun(current)">
                            执行
                        </button>
                        <button v-if="rootOutcome" @click="startFeedback()">评分</button>
                    </div>
                </div>
            </div>

            <div v-else class="body empty-new">
                <div class="hero">
                    <h1>mazi · Goal/Task/Step</h1>
                    <p>输入一个任务，运行一次 Goal 会话：intake + work Goal → 规划 → 逐 Task 执行 → 树快照留痕。</p>
                    <textarea
                        ref="composerEl"
                        v-model="newText"
                        rows="3"
                        class="hero-input"
                        placeholder="例如：读取 README.md 并汇报"
                        @keydown.enter.exact.prevent="submitNewRun()"
                    ></textarea>
                    <button :disabled="busy || !newText.trim()" @click="submitNewRun()">
                        {{ busy ? '运行中…' : '运行新会话' }}
                    </button>
                    <p class="hint">
                        当前工作区：{{ workspaceRoot || '（未选择）' }}
                        <button class="mini" @click="pickWorkspace()">选择…</button>
                    </p>
                </div>
            </div>
        </section>

        <aside v-if="rightOpen" class="right">
            <div class="right-head">
                <span>事件流</span>
                <select v-model="events.types">
                    <option value="all">全部类型</option>
                    <option v-for="t in eventTypesAvailable" :key="t" :value="t">{{ t }}</option>
                </select>
            </div>
            <ul class="evlist">
                <li v-for="e in visibleEvents" :key="e.eventId">
                    <span class="pill" :class="eventTypeClass(e.type)">{{ e.type }}</span>
                    <span class="evmeta">{{ fmtClock(e.timestamp) }} · {{ short(e.sessionId, 18) }}</span>
                </li>
                <li v-if="!visibleEvents.length" class="muted">（无事件）</li>
            </ul>
        </aside>

        <div v-if="feedback.open" class="modal">
            <div class="modal-card">
                <h3>反馈 · {{ short(current, 24) }}</h3>
                <p class="hint">评分 {{ feedback.rating }} / 5</p>
                <div class="stars">
                    <button v-for="n in 5" :key="n" :class="{ on: n <= feedback.rating }" @click="feedback.rating = n">
                        {{ n }}
                    </button>
                </div>
                <textarea v-model="feedback.content" rows="3" placeholder="补充说明（可选）"></textarea>
                <div class="row">
                    <button @click="feedback.open = false">取消</button>
                    <button @click="submitFeedback()">提交</button>
                </div>
            </div>
        </div>

        <div v-if="showSettings" class="modal">
            <div class="modal-card wide">
                <div class="tabs">
                    <button :class="{ on: settingsTab === 'config' }" @click="settingsTab = 'config'">配置</button>
                    <button :class="{ on: settingsTab === 'prefs' }" @click="settingsTab = 'prefs'">偏好</button>
                </div>
                <pre v-if="settingsTab === 'config'" class="json">{{ JSON.stringify(cfg, null, 2) }}</pre>
                <div v-else class="prefs">
                    <p>主题：{{ theme }}（顶栏 ◐ 切换 light / dark / system）</p>
                    <p>
                        Profile / Ledger 面板随旧 user_interactions / failure_ledger 记录删除，待 C3e/OBS
                        观测账目卷落地后按新事件重建。
                    </p>
                </div>
                <div class="row">
                    <button @click="showSettings = false">关闭</button>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.shell {
    display: flex;
    height: 100vh;
}
.sidebar {
    width: 264px;
    min-width: 264px;
    border-right: 1px solid var(--border);
    background: var(--bg-panel);
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    overflow-y: auto;
}
.sidebar.hidden {
    display: none;
}
.brand span {
    color: var(--fg-secondary);
    margin-left: 6px;
    font-size: 13px;
}
.newbtn {
    width: 100%;
}
.search {
    width: 100%;
}
.groups {
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.group-head {
    display: flex;
    justify-content: space-between;
    color: var(--fg-secondary);
    font-size: 12px;
    text-transform: uppercase;
    align-items: center;
}
.conv {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    width: 100%;
    text-align: left;
    margin: 2px 0;
}
.conv.on {
    background: var(--bg-active);
    border-color: var(--accent);
}
.ctitle {
    font-weight: 500;
    width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.csub {
    color: var(--fg-secondary);
    font-size: 12px;
}
.main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    background: var(--bg-chat);
}
.topbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-panel);
}
.crumb {
    flex: 1;
    display: flex;
    gap: 8px;
    align-items: center;
    overflow: hidden;
}
.title {
    font-weight: 600;
}
.runid {
    color: var(--fg-secondary);
    font-size: 12px;
}
.tools {
    display: flex;
    gap: 6px;
}
.tools .on {
    border-color: var(--accent);
    color: var(--accent);
}
.errbar {
    background: color-mix(in srgb, var(--error) 15%, transparent);
    color: var(--error);
    padding: 6px 12px;
    font-size: 13px;
}
.body {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.manage-row {
    display: flex;
    gap: 8px;
    align-items: center;
}
.title-input {
    flex: 1;
    max-width: 420px;
}
.danger {
    color: var(--error);
}
.runsbar {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    align-items: center;
}
.runs-label {
    color: var(--fg-secondary);
    font-size: 12px;
    text-transform: uppercase;
}
.chip {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    max-width: 240px;
    overflow: hidden;
}
.chip.on {
    background: var(--bg-active);
    border-color: var(--accent);
}
.chip-main {
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.chip-sub {
    color: var(--fg-secondary);
    font-size: 11px;
}
.content {
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.summary {
    color: var(--fg-secondary);
    display: flex;
    gap: 10px;
    align-items: center;
}
.outcome.ok {
    color: var(--ok);
}
.outcome.fail {
    color: var(--error);
}
.bubble {
    background: var(--user-bubble);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px 12px;
}
.bubble-head {
    color: var(--fg-secondary);
    font-size: 12px;
    margin-bottom: 4px;
}
.final {
    white-space: pre-wrap;
    margin: 0;
    font-family: inherit;
}
.goal-card {
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg-panel);
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.goal-head,
.task-head {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
}
.statement {
    flex: 1;
    min-width: 0;
}
.task-title {
    color: var(--fg-secondary);
}
.pill {
    border-radius: 999px;
    padding: 1px 8px;
    font-size: 12px;
    border: 1px solid var(--border);
    background: var(--status-bg);
    white-space: nowrap;
}
.pill.active,
.pill.pending,
.pill.running {
    border-color: var(--accent);
    color: var(--accent);
}
.pill.succeeded,
.pill.ok,
.pill.succeeded {
    border-color: var(--ok);
    color: var(--ok);
}
.pill.failed,
.pill.error,
.pill.blocked {
    border-color: var(--error);
    color: var(--error);
}
.pill.intake {
    border-color: var(--warn);
    color: var(--warn);
}
.pill.work {
    border-color: var(--accent);
    color: var(--accent);
}
.pill.warn {
    border-color: var(--warn);
    color: var(--warn);
}
.pill.taskid {
    font-family: ui-monospace, monospace;
}
.steps {
    list-style: none;
    margin: 4px 0 0;
    padding: 0 0 0 4px;
    display: flex;
    flex-direction: column;
    gap: 3px;
}
.steps li {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 13px;
}
.glyph {
    width: 18px;
}
.step-kind {
    color: var(--fg);
    width: 90px;
}
.step-id {
    color: var(--fg-secondary);
    font-size: 11px;
    font-family: ui-monospace, monospace;
}
.when {
    color: var(--trace-text);
    font-size: 11px;
    margin-left: auto;
}
.empty,
.muted {
    color: var(--fg-secondary);
    font-size: 13px;
}
.empty-state {
    color: var(--fg-secondary);
    text-align: center;
    padding: 40px 0;
}
.composer {
    border-top: 1px solid var(--border);
    background: var(--bg-panel);
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.composer textarea {
    width: 100%;
}
.composer-row {
    display: flex;
    gap: 8px;
    align-items: center;
}
.user {
    width: 180px;
}
.empty-new {
    align-items: center;
    justify-content: center;
    text-align: center;
}
.hero h1 {
    margin: 0 0 6px;
}
.hero-input {
    width: min(560px, 90vw);
}
.hero .hint {
    color: var(--fg-secondary);
    font-size: 13px;
}
.hint {
    color: var(--fg-secondary);
    font-size: 13px;
}
.right {
    width: 300px;
    min-width: 300px;
    border-left: 1px solid var(--border);
    background: var(--bg-panel);
    overflow-y: auto;
    padding: 10px;
}
.right-head {
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
}
.evlist {
    list-style: none;
    margin: 8px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.evmeta {
    color: var(--fg-secondary);
    font-size: 11px;
}
.modal {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
}
.modal-card {
    width: 440px;
    max-width: 92vw;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.modal-card.wide {
    width: 640px;
}
.modal-card textarea {
    width: 100%;
}
.row {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
}
.stars {
    display: flex;
    gap: 6px;
}
.stars button.on {
    border-color: var(--warn);
    color: var(--warn);
}
.tabs {
    display: flex;
    gap: 6px;
}
.tabs .on {
    border-color: var(--accent);
    color: var(--accent);
}
.json {
    white-space: pre-wrap;
    max-height: 60vh;
    overflow: auto;
    background: var(--bg-code);
    padding: 10px;
    border-radius: 8px;
    font-size: 12px;
}
.mini {
    padding: 2px 8px;
    font-size: 12px;
}
.prefs p {
    color: var(--fg-secondary);
}
</style>
