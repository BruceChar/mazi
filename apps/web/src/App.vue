<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
    badge,
    busy,
    cfg,
    createAndRun,
    current,
    detail,
    events,
    fmtClock,
    fmtDuration,
    fmtTokens,
    fmtUsd,
    icon,
    loadConfig,
    loadProfile,
    loadSessions,
    metrics,
    relTime,
    runCurrent,
    select,
    sendFeedback,
    sessions,
    setTheme,
    short,
    stepLabel,
    stopEvents,
    theme,
    ui,
} from './store.js';

const prompt = ref('');
const q = ref('');
const draft = ref({
    statement: '',
    permission: 'read-only',
    budgetUsd: 0.5,
    maxSteps: 8,
    userId: '',
});
const profile = ref(null);
const feedbackSent = ref(false);
const openSteps = ref({});
const collapsedTurns = ref({});
const trajFilter = ref('all');
const selectedModel = ref('');

const cfgText = computed(() => {
    const c = cfg.value;
    if (!c) return '未连接后端';
    return `${c.home} · ${c.providers?.length ? c.providers.join(', ') : '未配置 provider'} · ${c.storage?.driver || 'sqlite'}`;
});

const modelOptions = computed(() => {
    const list = cfg.value?.providers || [];
    if (!list.length) return [{ id: 'scripted', label: 'Scripted Demo' }];
    return list.map((id) => ({ id, label: id }));
});

const defaultModel = computed(() => modelOptions.value[0]?.id || '-');

watch(
    modelOptions,
    (options) => {
        if (!options.some((option) => option.id === selectedModel.value)) {
            selectedModel.value = options[0]?.id || '';
        }
    },
    { immediate: true },
);

const sessionItems = computed(() => {
    const key = q.value.trim().toLowerCase();
    if (!key) return sessions.value;
    return sessions.value.filter((s) =>
        String(s.title || s.input || '').toLowerCase().includes(key),
    );
});

const chatRows = computed(() => {
    const rows = [];
    for (const turn of detail.value?.turns || []) {
        for (const step of turn.steps || []) {
            rows.push({ turn, step });
        }
    }
    return rows;
});

const canRun = computed(
    () => !!(detail.value && detail.value.outcome === undefined && detail.value.state === 'running'),
);

const budgetPct = computed(() => {
    const max = metrics.budget;
    if (!max) return null;
    return Math.min(100, Math.round((metrics.cost / max) * 100));
});

const avgTtft = computed(() =>
    metrics.steps && metrics.ttftSum ? Math.round(metrics.ttftSum / metrics.steps) : 0,
);

const tokRate = computed(() =>
    metrics.llmMs > 0 ? Math.round((metrics.tokens / metrics.llmMs) * 1000) : 0,
);

const eventTypes = computed(() => [
    'all',
    ...new Set(events.list.map((e) => e.type)),
]);

const filteredEvents = computed(() =>
    events.list
        .filter((e) => ui.eventTypes === 'all' || e.type === ui.eventTypes)
        .slice(-300)
        .reverse(),
);

function isOpenStep(stepId) {
    return openSteps.value[stepId] ?? true;
}

function toggleOpenStep(stepId) {
    openSteps.value[stepId] = !(openSteps.value[stepId] ?? true);
}

function isTurnOpen(turnId) {
    return collapsedTurns.value[turnId] !== false;
}

function toggleTurn(turnId) {
    collapsedTurns.value[turnId] = !isTurnOpen(turnId);
}

function turnStart(row, index) {
    if (index === 0) return true;
    return chatRows.value[index - 1].turn.turnId !== row.turn.turnId;
}

function stepTitle(row) {
    const s = row.step;
    const p = s.payload || {};
    if (s.kind === 'thinking') return short(p.content, 80);
    if (s.kind === 'tool_call') {
        const args = short(JSON.stringify(p.arguments || {}), 70);
        return `${p.toolName} ${args}`;
    }
    if (s.kind === 'observation') return short(p.content, 110);
    return s.stepId;
}

function stepBody(row) {
    const p = row.step.payload || {};
    if (row.step.kind === 'tool_call') {
        return {
            title: `${p.toolName || 'tool'}`,
            json: JSON.stringify(p.arguments || {}, null, 2),
        };
    }
    return { title: '', text: p.content || '' };
}

function rowDuration(row) {
    return fmtDuration(row.step.usage?.timing?.totalMs);
}

function rowTokens(row) {
    const v = row.step.usage?.vendor;
    return fmtTokens((v?.inputTokens || 0) + (v?.outputTokens || 0));
}

function rowModel(row) {
    return row.step.model?.modelId || row.turn.capacity?.model?.modelId || '-';
}

function auditTitle() {
    const audit = ui.audit;
    if (!audit?.step) return '';
    return `Step #${audit.step.seq} · ${stepLabel(audit.step.kind)}`;
}

function openAudit(row) {
    ui.audit = { turn: row.turn, step: row.step };
    ui.auditSub = 'actual';
    ui.drawerTab = 'audit';
    ui.drawer = true;
}

function openAuditFromStep(turn, step) {
    ui.audit = { turn, step };
    ui.auditSub = 'actual';
    ui.drawerTab = 'audit';
    ui.drawer = true;
}

function openSessionLog() {
    ui.drawerTab = 'events';
    ui.drawer = true;
}

function closeDrawer() {
    ui.drawer = false;
}

function auditJson() {
    const audit = ui.audit;
    if (!audit) return '';
    if (ui.auditSub === 'declared') {
        return JSON.stringify(audit.turn?.contract || {}, null, 2);
    }
    if (ui.auditSub === 'authorized') {
        return JSON.stringify(audit.turn?.capacity || {}, null, 2);
    }
    const s = audit.step;
    return JSON.stringify(
        {
            sessionId: s.sessionId,
            turnId: s.turnId,
            stepId: s.stepId,
            seq: s.seq,
            kind: s.kind,
            status: s.status,
            payload: s.payload,
            model: s.model,
            usage: s.usage,
            contract: audit.turn?.contract || null,
            capacity: audit.turn?.capacity || null,
        },
        null,
        2,
    );
}

function usageSegs() {
    const usage = ui.audit?.step?.usage;
    if (!usage) return { segs: [], total: 0 };
    const r = usage.runtime || {};
    const raw = [
        ['sys', 'System', r.systemPromptTokens, '#60a5fa'],
        ['hist', 'History', r.historyTokens, '#a78bfa'],
        ['tool', 'Tool schema', r.toolSchemaTokens, '#34d399'],
        ['in', 'New input', r.newInputTokens, '#fbbf24'],
        ['obs', 'Observation', r.observationTokens, '#f472b6'],
    ].filter(([, , v]) => Number(v) > 0);
    const total = raw.reduce((acc, [, , v]) => acc + Number(v), 0) || 1;
    const segs = raw.map(([key, label, value, color]) => ({
        key,
        label,
        value,
        color,
        width: Math.max(2, Math.round((Number(value) / total) * 100)),
    }));
    return { segs, total };
}

function vendorText() {
    const usage = ui.audit?.step?.usage;
    if (!usage) return null;
    const v = usage.vendor || {};
    const c = usage.cost || {};
    const t = usage.timing || {};
    return {
        input: v.inputTokens || 0,
        output: v.outputTokens || 0,
        cacheRead: v.cacheReadInputTokens || 0,
        cacheWrite: v.cacheCreationInputTokens || 0,
        reasoning: v.reasoningOutputTokens || 0,
        totalCost: c.totalCostUsd || 0,
        tier: c.priceTierApplied || '-',
        version: c.pricingVersion || '-',
        ttft: t.ttftMs || 0,
        totalMs: t.totalMs || 0,
    };
}

function eventLine(event) {
    const ids = [event.sessionId, event.turnId, event.stepId].filter(Boolean).join('/');
    return ids ? `${event.type}  ·  ${ids}` : event.type;
}

function copyText(text) {
    if (navigator.clipboard) {
        void navigator.clipboard.writeText(text);
    }
}

function copyRow(row) {
    copyText(
        JSON.stringify(
            {
                sessionId: row.step.sessionId,
                turnId: row.step.turnId,
                stepId: row.step.stepId,
                kind: row.step.kind,
                payload: row.step.payload,
                usage: row.step.usage,
            },
            null,
            2,
        ),
    );
}

async function rate(row, rating) {
    feedbackSent.value = true;
    try {
        await sendFeedback(row.step.sessionId, rating, `step ${row.step.stepId}`);
    } catch (error) {
        ui.err = String(error);
    }
}

async function submitPrompt() {
    const text = prompt.value.trim();
    if (!text) {
        if (current.value && canRun.value) {
            await runCurrent(current.value);
        }
        return;
    }
    prompt.value = '';
    await createAndRun(true, {
        statement: text,
        permissionCeiling: draft.value.permission,
        maxCostUsd: draft.value.budgetUsd,
        maxSteps: draft.value.maxSteps,
        userId: draft.value.userId || undefined,
    });
}

async function submitNew(exec) {
    await createAndRun(exec, {
        statement: draft.value.statement,
        permissionCeiling: draft.value.permission,
        maxCostUsd: draft.value.budgetUsd,
        maxSteps: draft.value.maxSteps,
        userId: draft.value.userId || undefined,
    });
}

async function switchView(name) {
    ui.view = name;
    if (name === 'profile') {
        profile.value = await loadProfile('me');
    }
}

function cycleTheme() {
    setTheme(theme.value === 'dark' ? 'light' : 'dark');
}

async function openSession(sessionId) {
    await select(sessionId);
}

onMounted(async () => {
    await loadConfig();
    await loadSessions();
    if (sessions.value[0]) {
        await select(sessions.value[0].sessionId);
    }
});

onBeforeUnmount(() => {
    stopEvents();
});
</script>

<template>
    <header class="topbar">
        <div class="topbar-left">
            <button class="icon-btn sidebar-toggle" title="折叠/展开侧边栏" @click="ui.sidebar = !ui.sidebar">☰</button>
            <span class="brand">mazi<em>HARNESS</em></span>
            <button class="new-chat-top" @click="ui.showNew = true">＋ 新会话</button>
        </div>
        <div class="topbar-title" :title="detail && detail.rawIntent">
            {{ detail ? detail.rawIntent : 'AI Agent Harness' }}
        </div>
        <div class="topbar-right">
            <span class="api-dim" id="apilog"></span>
            <i class="dot" :class="busy ? 'busy' : cfg && cfg.providers && cfg.providers.length ? 'ok' : 'bad'"></i>
            <button class="ghost" @click="openSessionLog">Session 日志</button>
            <button class="icon-btn" :title="theme === 'dark' ? '切换到浅色' : '切换到深色'" @click="cycleTheme">
                {{ theme === 'dark' ? '☀️' : '🌙' }}
            </button>
        </div>
    </header>

    <div class="app-shell">
        <aside class="sidebar" :class="{ show: ui.sidebar }">
            <div class="sidebar-new">
                <button class="primary new-session" @click="ui.showNew = true">＋ 新会话</button>
            </div>
            <div class="workspace-head">
                <span>工作区</span>
                <span class="head-icons"><i>🔍</i><i>≡</i><i>＋</i></span>
            </div>
            <div class="search-box">
                <input v-model="q" placeholder="搜索会话…" />
            </div>
            <div class="sidebar-scroll">
                <div class="group">
                    <div class="group-head">📁 未分组 · {{ sessions.length }}</div>
                    <ul class="session-list">
                        <li
                            v-for="s in sessionItems"
                            :key="s.sessionId"
                            :class="{ active: current === s.sessionId }"
                            @click="openSession(s.sessionId)"
                        >
                            <div class="session-title">{{ s.title || s.input }}</div>
                            <div class="session-meta">
                                <span class="badge" :class="badge(s.outcome)">{{ s.outcome || 'recording' }}</span>
                                <span>{{ s.turns ?? '-' }} turns</span>
                                <span>{{ fmtUsd(s.costUsd) }}</span>
                                <span class="time">{{ relTime(s.updatedAt || s.createdAt) }}</span>
                            </div>
                        </li>
                        <li v-if="!sessionItems.length" class="empty-sidebar">暂无会话</li>
                    </ul>
                </div>
            </div>
            <nav class="sidebar-nav">
                <button :class="{ on: ui.view === 'chat' }" @click="switchView('chat')">💬 会话</button>
                <button :class="{ on: ui.view === 'profile' }" @click="switchView('profile')">👤 画像</button>
                <button :class="{ on: ui.view === 'ledger' }" @click="switchView('ledger')">📒 账本</button>
                <button :class="{ on: ui.view === 'settings' }" @click="switchView('settings')">⚙️ 设置</button>
            </nav>
        </aside>

        <main class="workspace">
            <template v-if="ui.view === 'chat'">
                <div class="main-tabs">
                    <button :class="{ on: ui.mainTab === 'chat' }" @click="ui.mainTab = 'chat'">对话</button>
                    <button :class="{ on: ui.mainTab === 'traj' }" @click="ui.mainTab = 'traj'">轨迹</button>
                </div>
                <div v-if="detail" class="session-strip">
                    <div class="session-id" title="Session ID">{{ detail.sessionId }}</div>
                    <div class="strip-actions">
                        <button v-if="canRun" :disabled="busy" @click="runCurrent(current)">▶ 执行</button>
                        <span v-if="detail.outcome" class="badge" :class="badge(detail.outcome)">{{ detail.outcome }}</span>
                        <button :disabled="busy" @click="runCurrent(current)" title="重新执行">↻</button>
                        <button title="复制 Session ID" @click="copyText(detail.sessionId)">⧉</button>
                    </div>
                </div>

                <div class="chat-scroll">
                    <div v-if="ui.err" class="error-banner">{{ ui.err }}</div>

                    <template v-if="ui.mainTab === 'chat'">
                        <div v-if="detail && detail.rawIntent" class="user-message">
                            <div class="msg-head"><span class="msg-icon">🧑</span><span class="msg-label">我</span></div>
                            <div class="msg-text">{{ detail.rawIntent }}</div>
                        </div>
                        <template v-for="(row, index) in chatRows" :key="row.step.stepId">
                            <div v-if="turnStart(row, index)" class="turn-divider">
                                Turn {{ (detail.turns || []).indexOf(row.turn) + 1 }}
                                <span class="muted-inline">{{ row.turn.status }} · attempt {{ row.turn.attempt }}</span>
                            </div>
                            <div class="msg" :class="[`msg-${row.step.kind}`, { open: isOpenStep(row.step.stepId) }]">
                                <div class="msg-head" @click="toggleOpenStep(row.step.stepId)">
                                    <span class="msg-icon">{{ icon(row.step.kind) }}</span>
                                    <span class="msg-label">{{ stepLabel(row.step.kind) }}</span>
                                    <span class="msg-title">{{ stepTitle(row) }}</span>
                                    <span class="msg-brief">#{{ row.step.seq }} · {{ row.step.status }} · {{ rowModel(row) }}</span>
                                    <button class="mini chevron">{{ isOpenStep(row.step.stepId) ? '▾' : '▸' }}</button>
                                </div>
                                <div v-if="isOpenStep(row.step.stepId)" class="msg-body">
                                    <template v-if="row.step.kind === 'tool_call'">
                                        <div class="mono-block">
                                            <div class="mono-title">🔧 {{ stepBody(row).title }}</div>
                                            <pre>{{ stepBody(row).json }}</pre>
                                        </div>
                                    </template>
                                    <pre v-else class="plain-text">{{ stepBody(row).text }}</pre>
                                </div>
                                <div class="msg-foot">
                                    <button class="mini like" title="有帮助" @click="rate(row, 5)">👍</button>
                                    <button class="mini like" title="没帮助" @click="rate(row, 1)">👎</button>
                                    <button class="mini" @click="copyRow(row)">📋 复制</button>
                                    <span class="meta-gap"></span>
                                    <span class="meta">用量 {{ rowTokens(row) }} tok</span>
                                    <span class="meta">用时 {{ rowDuration(row) }}</span>
                                    <span class="meta">{{ fmtClock(row.step.startedAt) }}</span>
                                    <button class="mini audit-link" @click="openAudit(row)">审计</button>
                                </div>
                            </div>
                        </template>
                        <div v-if="detail && !chatRows.length" class="empty-hint">
                            空会话：点击“▶ 执行”让 harness 开始工作
                        </div>
                        <div v-if="feedbackSent && detail && detail.outcome" class="ok-banner">反馈已记录 👍</div>
                    </template>

                    <template v-else>
                        <div class="toolbar">
                            <button
                                v-for="f in ['all', 'thinking', 'tool_call', 'observation']"
                                :key="f"
                                class="chip"
                                :class="{ on: trajFilter === f }"
                                @click="trajFilter = f"
                            >
                                {{ f }}
                            </button>
                        </div>
                        <div v-for="(turn, tIndex) in (detail && detail.turns) || []" :key="turn.turnId" class="traj-turn">
                            <div class="traj-turn-head" @click="toggleTurn(turn.turnId)">
                                <span class="chevron">{{ isTurnOpen(turn.turnId) ? '▾' : '▸' }}</span>
                                <span>Turn {{ tIndex + 1 }} · {{ (turn.contract && turn.contract.statement) || turn.turnId }}</span>
                                <span class="muted-inline">{{ turn.status }}</span>
                            </div>
                            <div v-if="isTurnOpen(turn.turnId)" class="traj-tree">
                                <div
                                    v-for="step in turn.steps.filter((s) => trajFilter === 'all' || s.kind === trajFilter)"
                                    :key="step.stepId"
                                    class="traj-step"
                                    @click="openAuditFromStep(turn, step)"
                                >
                                    <span class="msg-icon">{{ icon(step.kind) }}</span>
                                    <span class="traj-title">{{ short(stepTitle({ turn, step }), 72) }}</span>
                                    <span class="muted-inline">#{{ step.seq }} {{ step.status }}</span>
                                    <span v-if="step.model" class="muted-inline">{{ step.model.modelId }}</span>
                                    <span v-if="step.usage" class="muted-inline">{{ fmtTokens(step.usage.vendor.inputTokens + step.usage.vendor.outputTokens) }} tok</span>
                                </div>
                                <div v-if="!turn.steps.length" class="empty-hint">无步骤</div>
                            </div>
                        </div>
                    </template>
                </div>

                <div class="input-area">
                    <button class="icon-btn add-btn" title="添加附件/引用" @click="ui.showNew = true">＋</button>
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
                        <button class="ghost" title="刷新状态" @click="runCurrent(current)">↻</button>
                        <button class="send" :disabled="busy" title="发送" @click="submitPrompt">⬆</button>
                    </div>
                </div>
            </template>

            <template v-else-if="ui.view === 'settings'">
                <div class="page-card">
                    <h1>设置</h1>
                    <div class="field-row"><label>数据目录</label><input :value="cfg ? cfg.home : ''" readonly /></div>
                    <div class="field-row"><label>存储</label><input :value="cfg ? `${cfg.storage.driver} · ${cfg.storage.db}` : ''" readonly /></div>
                    <div class="field-row"><label>Provider</label><div class="value-text">{{ cfg ? cfg.providers.join(', ') : '-' }}</div></div>
                    <div class="field-row"><label>主题</label><select :value="theme" @change="setTheme($event.target.value)"><option value="light">浅色</option><option value="dark">深色</option><option value="system">跟随系统</option></select></div>
                    <div class="muted-block">配置保存在 ~/.mazi（providers/tools/flags.json）。修改后重启 server。</div>
                </div>
            </template>

            <template v-else-if="ui.view === 'profile'">
                <div class="page-card">
                    <h1>用户画像</h1>
                    <pre>{{ profile ? JSON.stringify(profile, null, 2) : '暂无数据（带 userId 运行会话后可见）' }}</pre>
                </div>
            </template>

            <template v-else>
                <div class="page-card">
                    <h1>失败分类账</h1>
                    <div class="muted-block">failure_ledger 将在存储 SPI 落地后提供；当前可从失败会话的轨迹定位。</div>
                </div>
            </template>
        </main>
    </div>

    <footer class="statusbar">
        <span class="stat"><b>{{ metrics.turns }}</b> 轮</span>
        <span class="stat"><b>{{ metrics.steps }}</b> 步</span>
        <span class="stat">LLM <b>{{ fmtDuration(metrics.llmMs) }}</b></span>
        <span class="stat">工具 <b>{{ metrics.toolCalls }}</b> 次</span>
        <span class="stat">TTFT <b>{{ avgTtft }}ms</b></span>
        <span class="stat"><b>{{ tokRate }}</b> tok/s</span>
        <span class="stat">tokens <b>{{ fmtTokens(metrics.tokens) }}</b></span>
        <span class="stat">cost <b>{{ fmtUsd(metrics.cost) }}</b></span>
        <span class="stat model-stat">{{ metrics.provider }} / {{ metrics.model }}</span>
        <span v-if="budgetPct !== null" class="stat budget-stat">预算 {{ budgetPct }}%</span>
    </footer>

    <aside v-if="ui.drawer" class="drawer">
        <div class="drawer-head">
            <div class="drawer-tabs">
                <button :class="{ on: ui.drawerTab === 'audit' }" @click="ui.drawerTab = 'audit'">审计</button>
                <button :class="{ on: ui.drawerTab === 'events' }" @click="ui.drawerTab = 'events'">事件</button>
            </div>
            <button class="icon-btn" title="关闭" @click="closeDrawer">✕</button>
        </div>

        <div v-if="ui.drawerTab === 'audit'" class="drawer-body">
            <div class="drawer-title">{{ auditTitle() }}</div>
            <div class="drawer-tabs sub">
                <button
                    v-for="v in ['declared', 'authorized', 'actual', 'usage']"
                    :key="v"
                    :class="{ on: ui.auditSub === v }"
                    @click="ui.auditSub = v"
                >
                    {{ { declared: '声明', authorized: '授权', actual: '实际', usage: '用量' }[v] }}
                </button>
            </div>
            <div v-if="ui.audit && ui.audit.step">
                <pre v-if="ui.auditSub !== 'usage'" class="audit-json">{{ auditJson() }}</pre>
                <template v-else>
                    <div v-for="seg in usageSegs().segs" :key="seg.key" class="usage-row">
                        <span>{{ seg.label }}</span><span>{{ seg.value }}</span>
                    </div>
                    <div class="usage-bar"><i v-for="seg in usageSegs().segs" :key="seg.key" :style="{ width: seg.width + '%', background: seg.color }"></i></div>
                    <div v-if="vendorText()" class="audit-note">
                        Vendor: in {{ vendorText().input }} / out {{ vendorText().output }}
                        <span v-if="vendorText().reasoning"> / reasoning {{ vendorText().reasoning }}</span><br />
                        Cache: read {{ vendorText().cacheRead }} · write {{ vendorText().cacheWrite }}<br />
                        Timing: TTFT {{ vendorText().ttft }}ms · total {{ vendorText().totalMs }}ms<br />
                        Cost: {{ fmtUsd(vendorText().totalCost) }} · tier {{ vendorText().tier }} · {{ vendorText().version }}
                    </div>
                </template>
            </div>
            <div v-else class="empty-hint">点击左侧消息或轨迹 Step 查看声明/授权/实际/用量</div>
        </div>

        <div v-else class="drawer-body">
            <div class="drawer-tabs sub">
                <select v-model="ui.eventTypes" title="事件类型">
                    <option v-for="t in eventTypes" :key="t" :value="t">{{ t }}</option>
                </select>
            </div>
            <div class="event-log">
                <div v-for="e in filteredEvents" :key="e.eventId" class="event-row">
                    <span class="event-time">{{ fmtClock(e.timestamp) }}</span>
                    <span class="event-type" :class="e.type.startsWith('tool') || e.type.startsWith('policy') ? 'warn' : ''">{{ e.type }}</span>
                    <span class="event-ids">{{ [e.turnId, e.stepId].filter(Boolean).join('/') || 'session' }}</span>
                </div>
                <div v-if="!filteredEvents.length" class="empty-hint">暂无事件</div>
            </div>
        </div>
    </aside>

    <div v-if="ui.showNew" class="modal-mask" @click.self="ui.showNew = false">
        <div class="modal">
            <h1>新建会话 · GoalContract</h1>
            <div class="field-row"><label>任务</label><textarea v-model="draft.statement" rows="3" placeholder="目标陈述，例如：读取 README.md 并汇报"></textarea></div>
            <div class="grid2">
                <div class="field-row"><label>权限上限</label><select v-model="draft.permission"><option v-for="p in ['text', 'read-only', 'draft', 'approved', 'autonomous']" :key="p" :value="p">{{ p }}</option></select></div>
                <div class="field-row"><label>预算（USD）</label><input v-model.number="draft.budgetUsd" type="number" step="0.1" /></div>
                <div class="field-row"><label>最大步数</label><input v-model.number="draft.maxSteps" type="number" /></div>
                <div class="field-row"><label>UserId（可选）</label><input v-model="draft.userId" placeholder="me" /></div>
            </div>
            <div class="modal-actions">
                <button class="ghost" @click="ui.showNew = false">取消</button>
                <button @click="submitNew(false)">仅创建</button>
                <button class="primary" :disabled="busy" @click="submitNew(true)">创建并运行</button>
            </div>
        </div>
    </div>
</template>
