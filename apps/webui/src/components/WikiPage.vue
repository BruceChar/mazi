<script setup>
/**
 * Repository-backed project knowledge UI (project-wiki v2).
 * The page is read-only; documents and claims are maintained by runtime.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { API_BASE, api } from '../api.js';
import LineIcon from '../assets/LineIcon.vue';
import {
    ARM_EVENT_TYPES,
    applyArmEvent,
    armStreamText,
    initialArmLive,
} from '../scripts/arm-live.ts';
import { renderMarkdown } from '../scripts/markdown.ts';
import { freeChatWorkspace, workspaceRoot } from '../scripts/store.js';
import {
    readWikiSelectedPath,
    resolveWikiDocumentPath,
    resolveWikiSelectedPath,
    saveWikiSelectedPath,
    wikiClaimDisplayStatus,
    wikiClaimStatusLabel,
    wikiClaimsAttention,
    wikiDocumentGroupLabel,
    wikiDocumentLabel,
    wikiNoticeSummary,
    wikiOperationLabel,
    wikiRepositoryEmptyText,
} from '../scripts/wiki.ts';

const props = defineProps({
    workspace: { type: String, default: '' },
});
const emit = defineEmits(['close']);

const view = ref(null);
const loading = ref(false);
const error = ref('');
const operation = ref(null);
const backgroundSync = ref(null);
/** 本页打开后才完成的操作：短暂展示成功提示；刷新带入的旧成功状态不再占据页首。 */
const successNotice = ref(null);
let successTimer = null;
let observedRunningOperation = false;
const SUCCESS_NOTICE_TTL_MS = 8000;
const selectedPath = ref('INDEX.md');
const query = ref('');
const factDialogOpen = ref(false);
const factFilter = ref('all');
const live = ref(initialArmLive());
const wikiApprovals = ref([]);
const traceWidth = ref(readTraceWidth());
let operationTimer = null;
let syncTimer = null;
let operationStream = null;
let operationStreamRoot = '';
let resizeStartX = 0;
let resizeStartWidth = 0;
const TRACE_MIN_WIDTH = 260;
const TRACE_MAX_WIDTH = 720;
const TRACE_WIDTH_KEY = 'mazi.wiki.traceWidth';

const targetWorkspace = computed(
    () => props.workspace || workspaceRoot.value || freeChatWorkspace.value || '',
);
const repository = computed(() => view.value?.repository ?? null);
const documents = computed(() => repository.value?.docs ?? []);
const selectedDocument = computed(
    () => documents.value.find((doc) => doc.path === selectedPath.value) ?? documents.value[0],
);
const currentDocument = computed(
    () => documents.value.find((doc) => doc.path === 'state/current.md') ?? null,
);
const attention = computed(() => wikiClaimsAttention(repository.value?.summary));
const isEmpty = computed(() => repository.value === null || documents.value.length === 0);
const operationRunning = computed(() => operation.value?.state === 'running');
const actionsDisabled = computed(() => loading.value || operationRunning.value);
const traceOperation = computed(() => {
    if (operation.value?.state === 'queued' || operation.value?.state === 'running') {
        return operation.value;
    }
    if (backgroundSync.value?.state === 'queued' || backgroundSync.value?.state === 'running') {
        return backgroundSync.value;
    }
    return operation.value ?? backgroundSync.value;
});
const traceEntries = computed(() => [...(traceOperation.value?.trace ?? [])].slice(-12).reverse());
/**
 * 顶部状态提示要显示的操作：运行中 / 排队中 / 失败始终展示；
 * 成功只在本次打开页面后观察到完成时短暂展示，避免刷新后仍顶着旧代码块。
 */
const noticeOperation = computed(() => {
    const current = operation.value;
    if (!current) return null;
    if (current.state === 'queued' || current.state === 'running' || current.state === 'failed') {
        return current;
    }
    return successNotice.value?.id === current.id ? successNotice.value : null;
});
const streamText = computed(() => armStreamText(live.value));
const liveSteps = computed(() => [...live.value.steps].slice(-24).reverse());
const layoutStyle = computed(() => ({
    '--wiki-trace-width': `${traceWidth.value}px`,
}));
const factClaims = computed(() => {
    const all = [...(repository.value?.claims ?? [])];
    if (factFilter.value === 'active') return all.filter((claim) => claim.status === 'active');
    if (factFilter.value === 'attention') {
        return all.filter((claim) => claim.status === 'stale' || claim.status === 'missing');
    }
    return all;
});
const factDialogTitle = computed(() => {
    if (factFilter.value === 'active') return '有效事实';
    if (factFilter.value === 'attention') return '待核验事实';
    return '全部事实';
});

const filteredDocuments = computed(() => {
    const needle = query.value.trim().toLowerCase();
    if (!needle) return documents.value;
    return documents.value.filter((doc) =>
        `${doc.title} ${doc.path}`.toLowerCase().includes(needle),
    );
});

const navigationGroups = computed(() => {
    const order = ['overview', 'state', 'decisions', 'lessons', 'other'];
    return order
        .map((group) => ({
            group,
            label: wikiDocumentGroupLabel(group),
            docs: filteredDocuments.value.filter((doc) => doc.group === group),
        }))
        .filter((entry) => entry.docs.length > 0);
});

const indexDocument = computed(
    () => filteredDocuments.value.find((doc) => doc.group === 'index') ?? null,
);

const purpose = computed(() => {
    const index = repository.value?.index ?? '';
    return (
        index.match(/^>\s*(?:一句话|项目摘要)[:：]\s*(.+)$/m)?.[1]?.trim() ||
        '尚未形成项目定位摘要。'
    );
});

const projectType = computed(() => {
    const index = repository.value?.index ?? '';
    return index.match(/^>\s*(?:技术栈|项目类型)[:：]\s*(.+)$/m)?.[1]?.trim() || '通用项目';
});

const claims = computed(() => {
    const rank = { stale: 0, missing: 1, active: 2, retracted: 3 };
    return [...(repository.value?.claims ?? [])]
        .sort((left, right) => rank[left.status] - rank[right.status])
        .slice(0, 10);
});

const documentBody = computed(() => {
    const content = selectedDocument.value?.content ?? '';
    return content.replace(/^#\s+.+\r?\n+/, '');
});
const currentBody = computed(() => {
    const content = currentDocument.value?.content ?? '';
    return content.replace(/^#\s+.+\r?\n+/, '');
});

async function load() {
    loading.value = true;
    error.value = '';
    try {
        view.value = await api('/api/wiki' + queryForWorkspace());
        operation.value = view.value.operation ?? null;
        backgroundSync.value = view.value.backgroundSync ?? null;
        syncNoticeState();
        syncOperationStream();
        syncSelection();
        if (operationRunning.value) scheduleOperationPoll(operation.value.id);
        if (
            backgroundSync.value?.state === 'queued' ||
            backgroundSync.value?.state === 'running'
        ) {
            scheduleSyncPoll(backgroundSync.value.id);
        }
    } catch (err) {
        error.value = String(err);
        view.value = null;
    } finally {
        loading.value = false;
    }
}

async function startMaintenance(kind) {
    if (actionsDisabled.value) return;
    error.value = '';
    try {
        operation.value = await api(`/api/wiki/${kind}` + queryForWorkspace(), {
            method: 'POST',
        });
        syncNoticeState();
        syncOperationStream();
        scheduleOperationPoll(operation.value.id);
    } catch (err) {
        error.value = String(err);
    }
}

/**
 * 成功提示只在「本页看到操作从运行中落到成功」时出现 8 秒；
 * 刷新后 API 仍返回上一次 succeeded 操作，但不会再展示为绿色代码块。
 */
function syncNoticeState() {
    const current = operation.value;
    if (!current) {
        observedRunningOperation = false;
        hideSuccessNotice();
        return;
    }
    if (current.state === 'queued' || current.state === 'running') {
        observedRunningOperation = true;
        hideSuccessNotice();
        return;
    }
    if (current.state === 'failed') {
        observedRunningOperation = false;
        hideSuccessNotice();
        return;
    }
    if (observedRunningOperation) {
        observedRunningOperation = false;
        showSuccessNotice(current);
        return;
    }
    // 旧的 succeeded 操作（例如刷新带入的历史状态）不占页首。
    if (successNotice.value?.id !== current.id) hideSuccessNotice();
}

function showSuccessNotice(notice) {
    hideSuccessNotice();
    successNotice.value = notice;
    successTimer = setTimeout(() => {
        successNotice.value = null;
        successTimer = null;
    }, SUCCESS_NOTICE_TTL_MS);
}

function hideSuccessNotice() {
    if (successTimer) {
        clearTimeout(successTimer);
        successTimer = null;
    }
    successNotice.value = null;
}

function scheduleOperationPoll(operationId) {
    if (operationTimer) clearTimeout(operationTimer);
    operationTimer = setTimeout(async () => {
        operationTimer = null;
        try {
            operation.value = await api(`/api/wiki/operations/${operationId}`);
            syncNoticeState();
            syncOperationStream();
            if (operation.value.state === 'queued' || operation.value.state === 'running') {
                scheduleOperationPoll(operationId);
            } else if (operation.value.state === 'succeeded') {
                await load();
            }
        } catch (err) {
            error.value = String(err);
        }
    }, 1500);
}

function scheduleSyncPoll(operationId) {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(async () => {
        syncTimer = null;
        try {
            backgroundSync.value = await api(`/api/wiki/operations/${operationId}`);
            syncOperationStream();
            if (
                backgroundSync.value.state === 'queued' ||
                backgroundSync.value.state === 'running'
            ) {
                scheduleSyncPoll(operationId);
            } else {
                await load();
            }
        } catch (err) {
            error.value = String(err);
        }
    }, 1800);
}

function syncOperationStream() {
    const rootGoalId = traceOperation.value?.rootGoalId ?? '';
    if (!rootGoalId) {
        closeOperationStream();
        return;
    }
    if (operationStreamRoot === rootGoalId && operationStream) return;
    closeOperationStream();
    operationStreamRoot = rootGoalId;
    live.value = initialArmLive('running');
    wikiApprovals.value = [];
    if (typeof EventSource === 'undefined') return;
    const workspace = traceOperation.value?.workspace ?? '';
    const source = new EventSource(
        `${API_BASE}/api/events/${encodeURIComponent(rootGoalId)}?follow=1&workspace=${encodeURIComponent(workspace)}`,
    );
    const consume = (raw) => {
        try {
            const event = JSON.parse(raw.data);
            live.value = applyArmEvent(live.value, event);
            if (event.type === 'approval.requested') {
                const pending = event.payload;
                if (
                    pending?.invocationId &&
                    !wikiApprovals.value.some(
                        (item) => item.invocationId === pending.invocationId,
                    )
                ) {
                    wikiApprovals.value = [...wikiApprovals.value, pending];
                }
            } else if (
                event.type === 'approval.granted' ||
                event.type === 'approval.cancelled'
            ) {
                const invocationId = event.payload?.invocationId;
                if (invocationId) {
                    wikiApprovals.value = wikiApprovals.value.filter(
                        (item) => item.invocationId !== invocationId,
                    );
                }
            }
        } catch {
            // Ignore malformed SSE frames; the operation status still remains available.
        }
    };
    for (const type of ARM_EVENT_TYPES) source.addEventListener(type, consume);
    source.onerror = () => {
        if (live.value.status !== 'running') closeOperationStream();
    };
    operationStream = source;
}

function closeOperationStream() {
    if (operationStream) operationStream.close();
    operationStream = null;
    operationStreamRoot = '';
}

async function respondWikiApproval(
    item,
    decision,
    scope,
) {
    try {
        await api(`/api/approvals/${encodeURIComponent(item.invocationId)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ decision, ...(scope ? { scope } : {}) }),
        });
        wikiApprovals.value = wikiApprovals.value.filter(
            (current) => current.invocationId !== item.invocationId,
        );
    } catch (err) {
        error.value = String(err);
    }
}

function allowsApprovalScope(item, scope) {
    return !Array.isArray(item.allowedScopes) || item.allowedScopes.includes(scope);
}

function stepKindLabel(step) {
    if (step.kind === 'deliberation') return '模型';
    if (step.kind === 'invocation') return step.toolName || '工具';
    return step.kind || 'Step';
}

function stepBody(step) {
    return (
        step.thinking ||
        step.output ||
        step.answer ||
        step.content ||
        step.title ||
        ''
    );
}

function toolArgumentsLabel(step) {
    return step.toolArguments ? JSON.stringify(step.toolArguments, null, 2) : '';
}

function readTraceWidth() {
    if (typeof localStorage === 'undefined') return 340;
    const parsed = Number(localStorage.getItem(TRACE_WIDTH_KEY));
    return Number.isFinite(parsed)
        ? Math.max(TRACE_MIN_WIDTH, Math.min(TRACE_MAX_WIDTH, parsed))
        : 340;
}

function startTraceResize(event) {
    event.preventDefault();
    resizeStartX = event.clientX;
    resizeStartWidth = traceWidth.value;
    window.addEventListener('pointermove', resizeTrace);
    window.addEventListener('pointerup', stopTraceResize, { once: true });
}

function resizeTrace(event) {
    traceWidth.value = Math.max(
        TRACE_MIN_WIDTH,
        Math.min(TRACE_MAX_WIDTH, resizeStartWidth + resizeStartX - event.clientX),
    );
}

function stopTraceResize() {
    window.removeEventListener('pointermove', resizeTrace);
    localStorage.setItem(TRACE_WIDTH_KEY, String(traceWidth.value));
}

function syncSelection() {
    // 刷新 / 切回同一工作区时恢复上次阅读的文档；记录失效则回退索引页。
    selectedPath.value = resolveWikiSelectedPath(
        readWikiSelectedPath(targetWorkspace.value),
        documents.value,
    );
}

function queryForWorkspace() {
    return targetWorkspace.value
        ? '?workspace=' + encodeURIComponent(targetWorkspace.value)
        : '';
}

function updatedLabel(value) {
    if (!value) return '尚未提交';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const datePart = [
        date.getFullYear(),
        pad2(date.getMonth() + 1),
        pad2(date.getDate()),
    ].join('-');
    const timePart = [date.getHours(), date.getMinutes(), date.getSeconds()]
        .map(pad2)
        .join(':');
    return `${datePart} ${timePart}`;
}

function pad2(value) {
    return String(value).padStart(2, '0');
}

function elapsedLabel(startedAt) {
    const seconds = Math.max(0, Math.floor((Date.now() - Number(startedAt || Date.now())) / 1000));
    if (seconds < 60) return `${seconds} 秒`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
    return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`;
}

function traceStateLabel(value) {
    return {
        queued: '已入队',
        running: '运行中',
        succeeded: '已完成',
        failed: '失败',
    }[value] ?? value;
}

function traceMayBeStalled(value) {
    if (value?.state !== 'running') return false;
    const last = Number(value.lastHeartbeatAt || value.startedAt || Date.now());
    return Date.now() - last > 30_000;
}

function openFacts(filter) {
    factFilter.value = filter;
    factDialogOpen.value = true;
}

function openLinkedDocument(event) {
    const anchor = event.target?.closest?.('a');
    const href = anchor?.getAttribute('href');
    if (!anchor || !href) return;
    const path = resolveWikiDocumentPath(selectedPath.value, href);
    if (!path || !documents.value.some((doc) => doc.path === path)) return;
    event.preventDefault();
    selectedPath.value = path;
}

onMounted(load);
onBeforeUnmount(() => {
    if (operationTimer) clearTimeout(operationTimer);
    if (syncTimer) clearTimeout(syncTimer);
    hideSuccessNotice();
    closeOperationStream();
    window.removeEventListener('pointermove', resizeTrace);
});
watch(targetWorkspace, () => {
    void load();
});
watch(documents, syncSelection);
watch(selectedPath, (path) => {
    if (!path || !documents.value.some((doc) => doc.path === path)) return;
    saveWikiSelectedPath(targetWorkspace.value, path);
});
</script>

<template>
    <section class="wiki-page">
        <header class="wiki-head">
            <div class="wiki-title">
                <LineIcon name="observation" :size="17" />
                <strong>项目知识库</strong>
                <span v-if="repository" class="wiki-project">
                    {{ view.project || repository.root.split('/').at(-1) }}
                </span>
            </div>
            <div class="wiki-actions">
                <span class="wiki-version">v2 · Git-backed</span>
                <button
                    type="button"
                    :disabled="actionsDisabled"
                    :title="'读取 README、项目结构和关键入口，由 Agent 完成首次知识库填库'"
                    @click="startMaintenance('init')"
                >
                    <LineIcon name="plus" :size="13" />
                    {{ operationRunning && operation.kind === 'init' ? '初始化中…' : '初始化' }}
                </button>
                <button
                    type="button"
                    :disabled="actionsDisabled"
                    title="检查自上次 checkpoint 以来的变化，并核对 claims 与 oid"
                    @click="startMaintenance('update')"
                >
                    <LineIcon name="refresh" :size="13" />
                    {{ operationRunning && operation.kind === 'update' ? '更新中…' : '更新' }}
                </button>
                <button type="button" @click="emit('close')">返回对话</button>
            </div>
        </header>

        <p v-if="error" class="wiki-error">{{ error }}</p>
        <p
            v-else-if="noticeOperation"
            class="wiki-notice"
            :class="{ 'wiki-notice-error': noticeOperation.state === 'failed' }"
        >
            <template
                v-if="noticeOperation.state === 'queued' || noticeOperation.state === 'running'"
            >
                Agent 正在{{ noticeOperation.kind === 'init' ? '分析项目并初始化' : '检查项目变化并更新' }}
                Wiki · 已运行 {{ elapsedLabel(noticeOperation.startedAt) }}。完成后会自动刷新页面。
                <strong v-if="noticeOperation.approvalPending" class="wiki-stall-warning">
                    正在等待审批，请处理审批请求或终止任务。
                </strong>
                <strong v-else-if="traceMayBeStalled(noticeOperation)" class="wiki-stall-warning">
                    已超过 30 秒没有新 trace，可能正在等待模型响应或审批。
                </strong>
            </template>
            <template v-else-if="noticeOperation.state === 'failed'">
                {{ wikiOperationLabel(noticeOperation.kind) }}失败：{{
                    wikiNoticeSummary(noticeOperation)
                }}
            </template>
            <template v-else>
                {{ wikiNoticeSummary(noticeOperation) }}
            </template>
        </p>

        <section v-if="repository && !isEmpty" class="wiki-kpis">
            <button type="button" class="wiki-kpi" @click="openFacts('all')">
                <strong>{{ repository.summary.documents }}</strong>
                <span>知识文档</span>
            </button>
            <button type="button" class="wiki-kpi" @click="openFacts('active')">
                <strong>{{ repository.summary.active }}</strong>
                <span>有效事实</span>
            </button>
            <button
                type="button"
                class="wiki-kpi"
                :class="{ warn: attention > 0 }"
                @click="openFacts('attention')"
            >
                <strong>{{ attention }}</strong>
                <span>待核验</span>
            </button>
            <div class="wiki-kpi-wide">
                <strong>{{ projectType }}</strong>
                <span>项目类型</span>
            </div>
            <div>
                <strong>{{ updatedLabel(repository.latestCommit?.committedAt) }}</strong>
                <span>最近知识提交</span>
            </div>
        </section>

        <article
            v-if="repository && !isEmpty && currentDocument"
            class="wiki-current-panel"
        >
            <div class="wiki-current-head">
                <div>
                    <h3>当前状态</h3>
                    <p>{{ purpose }}</p>
                    <p class="wiki-current-hint">完整内容，可在卡片内滚动查看。</p>
                </div>
                <code>state/current.md</code>
            </div>
            <!-- eslint-disable-next-line vue/no-v-html -->
            <div class="wiki-current-markdown" v-html="renderMarkdown(currentBody)"></div>
        </article>

        <div v-if="loading && view === null" class="wiki-empty wiki-loading">
            <LineIcon name="refresh" :size="20" />
            <strong>正在读取项目知识库…</strong>
        </div>

        <div v-else-if="isEmpty && !error" class="wiki-empty">
            <LineIcon name="box" :size="24" />
            <strong>{{ wikiRepositoryEmptyText(repository) }}</strong>
            <p>
                项目 wiki 以仓库内 <code>wiki/</code> 为事实源。运行 project-wiki 的
                <code>init</code> 后，可在任意项目类型中使用。
            </p>
        </div>

        <div v-else-if="!error" class="wiki-layout" :style="layoutStyle">
            <aside class="wiki-nav">
                <label class="wiki-search">
                    <LineIcon name="search" :size="13" />
                    <input v-model="query" placeholder="筛选知识…" />
                </label>
                <button
                    v-if="indexDocument"
                    type="button"
                    class="wiki-nav-item wiki-nav-index"
                    :class="{ active: selectedPath === indexDocument.path }"
                    @click="selectedPath = indexDocument.path"
                >
                    <span>{{ wikiDocumentLabel(indexDocument) }}</span>
                    <small>INDEX.md</small>
                </button>
                <section v-for="group in navigationGroups" :key="group.group">
                    <h3>{{ group.label }}</h3>
                    <button
                        v-for="doc in group.docs"
                        :key="doc.path"
                        type="button"
                        class="wiki-nav-item"
                        :class="{ active: selectedPath === doc.path }"
                        @click="selectedPath = doc.path"
                    >
                        <span>{{ wikiDocumentLabel(doc) }}</span>
                        <small>{{ doc.path }}</small>
                    </button>
                </section>
                <p v-if="filteredDocuments.length === 0" class="wiki-muted">没有匹配的文档。</p>
            </aside>

            <main v-if="selectedDocument" class="wiki-content">
                <header class="wiki-doc-head">
                    <div>
                        <span>{{ wikiDocumentGroupLabel(selectedDocument.group) }}</span>
                        <h2>{{ wikiDocumentLabel(selectedDocument) }}</h2>
                    </div>
                    <code>{{ selectedDocument.path }}</code>
                </header>
                <!-- eslint-disable-next-line vue/no-v-html -->
                <article
                    class="wiki-markdown"
                    v-html="renderMarkdown(documentBody)"
                    @click="openLinkedDocument"
                ></article>
            </main>

            <aside class="wiki-context">
                <button
                    type="button"
                    class="wiki-context-resizer"
                    title="拖动调节 Trace 面板宽度"
                    aria-label="拖动调节 Trace 面板宽度"
                    @pointerdown="startTraceResize"
                ></button>
                <section v-if="traceOperation" class="wiki-context-card wiki-trace-card">
                    <div class="wiki-context-head">
                        <h3>后台任务 Trace</h3>
                        <span
                            class="wiki-trace-state"
                            :class="
                                traceOperation.approvalPending ? 'approval' : traceOperation.state
                            "
                        >
                            {{
                                traceOperation.approvalPending
                                    ? '等待审批'
                                    : traceStateLabel(traceOperation.state)
                            }}
                        </span>
                    </div>
                    <p class="wiki-trace-meta">
                        {{ traceOperation.kind === 'sync' ? 'Session 后台同步' : traceOperation.kind }}
                        · {{ elapsedLabel(traceOperation.startedAt) }}
                        · 最近事件
                        {{ updatedLabel(new Date(traceOperation.lastHeartbeatAt || traceOperation.startedAt).toISOString()) }}
                    </p>
                    <p
                        v-if="traceOperation.approvalPending"
                        class="wiki-trace-stalled approval"
                    >
                        后台 Agent 正在等待审批。处理右侧/系统审批请求后会自动继续。
                    </p>
                    <p v-else-if="traceMayBeStalled(traceOperation)" class="wiki-trace-stalled">
                        超过 30 秒没有新事件，可能正在等待模型响应或审批。
                    </p>
                    <div v-if="wikiApprovals.length" class="wiki-inline-approvals">
                        <strong>等待你的审批</strong>
                        <article
                            v-for="item in wikiApprovals"
                            :key="item.invocationId"
                        >
                            <p>{{ item.summary }}</p>
                            <div>
                                <span>{{ item.tool || item.capability }}</span>
                                <button
                                    type="button"
                                    @click="respondWikiApproval(item, 'rejected')"
                                >
                                    拒绝
                                </button>
                                <button
                                    type="button"
                                    @click="respondWikiApproval(item, 'granted', 'once')"
                                >
                                    允许一次
                                </button>
                                <button
                                    v-if="allowsApprovalScope(item, 'workspace')"
                                    type="button"
                                    @click="respondWikiApproval(item, 'granted', 'workspace')"
                                >
                                    本工作区允许
                                </button>
                            </div>
                        </article>
                    </div>
                    <div v-if="streamText" class="wiki-live-stream">
                        <div>
                            <span class="wiki-live-dot"></span>
                            模型正在思考 / 输出
                        </div>
                        <pre>{{ streamText }}</pre>
                    </div>
                    <ol v-if="liveSteps.length" class="wiki-live-steps">
                        <li
                            v-for="step in liveSteps"
                            :key="step.stepId"
                            :class="['wiki-live-step', step.kind]"
                        >
                            <div class="wiki-live-step-head">
                                <strong>{{ stepKindLabel(step) }}</strong>
                                <span>{{ step.status }}</span>
                            </div>
                            <p v-if="stepBody(step)">{{ stepBody(step) }}</p>
                            <pre v-if="step.kind === 'invocation' && step.toolArguments">{{ toolArgumentsLabel(step) }}</pre>
                            <pre
                                v-if="step.kind === 'invocation' && step.output"
                                class="wiki-live-output"
                            >{{ step.output }}</pre>
                        </li>
                    </ol>
                    <ol v-else-if="!streamText && traceEntries.length" class="wiki-trace-list">
                        <li v-for="entry in traceEntries" :key="entry.timestamp + entry.type">
                            <time>{{ updatedLabel(new Date(entry.timestamp).toISOString()) }}</time>
                            <span>{{ entry.label }}</span>
                        </li>
                    </ol>
                    <p
                        v-else-if="!streamText"
                        class="wiki-muted"
                    >
                        任务已创建，等待 trace 事件。
                    </p>
                </section>

                <section class="wiki-context-card">
                    <div class="wiki-context-head">
                        <h3>事实校验</h3>
                        <button type="button" class="wiki-text-button" @click="openFacts('all')">
                            查看全部
                        </button>
                    </div>
                    <div class="wiki-claim-grid">
                        <div><strong>{{ repository.summary.active }}</strong><span>有效</span></div>
                        <div><strong>{{ repository.summary.stale }}</strong><span>待复核</span></div>
                        <div><strong>{{ repository.summary.missing }}</strong><span>缺失</span></div>
                        <div><strong>{{ repository.summary.retracted }}</strong><span>遗忘/撤回</span></div>
                    </div>
                    <ul v-if="claims.length" class="wiki-claims">
                        <li v-for="claim in claims" :key="claim.id">
                            <span :class="['wiki-claim-dot', claim.status]"></span>
                            <div>
                                <strong>{{ claim.text || claim.id }}</strong>
                                <small>{{ wikiClaimDisplayStatus(claim) }}</small>
                            </div>
                        </li>
                    </ul>
                    <p v-else class="wiki-muted">尚未登记可校验事实。</p>
                </section>

                <section class="wiki-context-card wiki-provenance">
                    <div class="wiki-context-head">
                        <h3>事实来源</h3>
                        <LineIcon name="shield" :size="14" />
                    </div>
                    <code class="wiki-root">{{ repository.root }}</code>
                    <p v-if="repository.latestCommit">
                        <strong>{{ repository.latestCommit.hash }}</strong>
                        {{ repository.latestCommit.subject }}
                    </p>
                    <p v-else class="wiki-muted">知识库还没有 Git 提交。</p>
                    <p
                        v-if="backgroundSync"
                        class="wiki-background-sync"
                        :class="backgroundSync.state"
                    >
                        <strong>后台同步</strong>
                        {{
                            backgroundSync.state === 'queued'
                                ? '已入队'
                                : backgroundSync.state === 'running'
                                  ? '运行中'
                                  : backgroundSync.state === 'succeeded'
                                    ? '已完成'
                                    : '失败'
                        }}
                        · {{ updatedLabel(new Date(backgroundSync.startedAt).toISOString()) }}
                    </p>
                    <p v-if="backgroundSync?.summary" class="wiki-background-sync-summary">
                        {{ backgroundSync.summary }}
                    </p>
                    <p v-if="backgroundSync?.error" class="wiki-background-sync-summary error">
                        {{ backgroundSync.error }}
                    </p>
                </section>
            </aside>
        </div>

        <Teleport to="body">
            <div
                v-if="factDialogOpen"
                class="wiki-fact-mask"
                @click.self="factDialogOpen = false"
            >
                <section class="wiki-fact-dialog">
                    <header>
                        <div>
                            <h2>{{ factDialogTitle }}</h2>
                            <p>{{ factClaims.length }} 条</p>
                        </div>
                        <button type="button" title="关闭" @click="factDialogOpen = false">
                            <LineIcon name="close" :size="15" />
                        </button>
                    </header>
                    <div v-if="factClaims.length" class="wiki-fact-dialog-list">
                        <article v-for="claim in factClaims" :key="claim.id">
                            <div class="wiki-fact-dialog-title">
                                <span :class="['wiki-claim-dot', claim.status]"></span>
                                <strong>{{ claim.text || claim.id }}</strong>
                                <small>{{ wikiClaimDisplayStatus(claim) }}</small>
                            </div>
                            <code>{{ claim.id }}</code>
                            <p v-if="claim.retractedReason" class="wiki-muted">
                                {{ claim.retractedReason }}
                                <template v-if="claim.supersededBy">
                                    · 已由 {{ claim.supersededBy }} 替代
                                </template>
                            </p>
                            <ul v-if="claim.evidence.length">
                                <li v-for="evidence in claim.evidence" :key="evidence.file">
                                    <span>{{ wikiClaimStatusLabel(evidence.status) }}</span>
                                    <code>{{ evidence.file }}</code>
                                    <em v-if="evidence.hint">{{ evidence.hint }}</em>
                                </li>
                            </ul>
                            <p v-else class="wiki-muted">该事实没有 evidence。</p>
                        </article>
                    </div>
                    <p v-else class="wiki-fact-dialog-empty">当前筛选下没有事实。</p>
                </section>
            </div>
        </Teleport>
    </section>
</template>

<style scoped>
.wiki-page {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    padding: 12px 16px 16px;
    gap: 10px;
    overflow: hidden;
}
.wiki-head,
.wiki-title,
.wiki-actions {
    display: flex;
    align-items: center;
}
.wiki-head {
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
}
.wiki-title,
.wiki-actions {
    gap: 8px;
}
.wiki-title {
    min-width: 0;
}
.wiki-project {
    color: var(--fg-tertiary);
    font-size: 11px;
    overflow-wrap: anywhere;
}
.wiki-version {
    padding: 2px 7px;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent-text);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.02em;
}
.wiki-actions button {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
    color: var(--fg);
    padding: 5px 10px;
    font-size: 12px;
    cursor: pointer;
}
.wiki-actions button:hover {
    background: var(--bg-hover);
}
.wiki-error,
.wiki-notice {
    margin: 0;
    font-size: 12px;
}
.wiki-error {
    color: var(--error);
}
.wiki-notice {
    color: var(--ok);
    white-space: pre-wrap;
}
.wiki-notice-error {
    color: var(--error);
}
.wiki-stall-warning {
    display: block;
    margin-top: 4px;
    color: var(--warn);
}
.wiki-kpis {
    display: grid;
    grid-template-columns: 0.8fr 0.8fr 0.8fr minmax(150px, 1.25fr) 1.2fr;
    gap: 6px;
}
.wiki-kpis > div,
.wiki-kpis > .wiki-kpi {
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: 9px;
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
    color: var(--fg);
    text-align: left;
}
.wiki-kpis > .wiki-kpi {
    cursor: pointer;
}
.wiki-kpis > .wiki-kpi:hover {
    border-color: var(--accent);
    background: var(--bg-hover);
}
.wiki-kpis strong {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 15px;
    font-variant-numeric: tabular-nums;
}
.wiki-kpis span {
    color: var(--fg-tertiary);
    font-size: 10px;
}
.wiki-kpis .warn strong {
    color: var(--warn);
}
.wiki-current-panel {
    flex: 0 0 auto;
    display: grid;
    grid-template-columns: minmax(220px, 0.35fr) minmax(0, 1fr);
    gap: 14px;
    padding: 10px 12px;
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-md);
    background: var(--bg-panel);
}
.wiki-current-head {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
}
.wiki-current-head h3 {
    margin: 0;
    font-size: 13px;
}
.wiki-current-head p {
    margin: 5px 0 0;
    color: var(--fg-tertiary);
    font-size: 10px;
    line-height: 1.45;
}
.wiki-current-head .wiki-current-hint {
    margin-top: 2px;
    font-size: 9px;
}
.wiki-current-head code {
    color: var(--fg-tertiary);
    font-size: 9px;
}
.wiki-current-markdown {
    min-width: 0;
    max-height: 170px;
    overflow-y: auto;
    padding-right: 4px;
    color: var(--fg-secondary);
    font-size: 11px;
    line-height: 1.5;
    overflow-wrap: anywhere;
}
.wiki-current-markdown :deep(h2) {
    margin: 0 0 4px;
    color: var(--fg);
    font-size: 11px;
}
.wiki-current-markdown :deep(h2:not(:first-child)) {
    margin-top: 8px;
}
.wiki-current-markdown :deep(p),
.wiki-current-markdown :deep(ul) {
    margin: 4px 0;
}
.wiki-current-markdown :deep(ul) {
    padding-left: 16px;
}
.wiki-layout {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 214px minmax(0, 1fr) var(--wiki-trace-width, 340px);
    gap: 10px;
}
.wiki-nav,
.wiki-content,
.wiki-context-card {
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-md);
    background: var(--bg-panel);
}
.wiki-nav,
.wiki-content,
.wiki-context {
    min-height: 0;
    overflow-y: auto;
}
.wiki-nav {
    padding: 8px;
}
.wiki-search {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-bottom: 8px;
    padding: 0 7px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--fg-tertiary);
}
.wiki-search input {
    width: 100%;
    min-width: 0;
    padding: 6px 0;
    border: none;
    background: transparent;
    color: var(--fg);
    font-size: 11px;
    outline: none;
}
.wiki-nav section {
    margin-top: 10px;
}
.wiki-nav h3 {
    margin: 0 5px 4px;
    color: var(--fg-tertiary);
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
}
.wiki-nav-item {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
    padding: 6px 7px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--fg-secondary);
    text-align: left;
    cursor: pointer;
}
.wiki-nav-item:hover,
.wiki-nav-item.active {
    background: var(--bg-hover);
    color: var(--fg);
}
.wiki-nav-item.active {
    box-shadow: inset 2px 0 0 var(--accent);
}
.wiki-nav-index {
    background: var(--bg);
}
.wiki-nav-item span {
    width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11px;
    font-weight: 500;
}
.wiki-nav-item small {
    width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg-tertiary);
    font-size: 9px;
}
.wiki-content {
    padding: 16px 20px 26px;
}
.wiki-doc-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 18px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border-soft);
}
.wiki-doc-head span {
    color: var(--fg-tertiary);
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
}
.wiki-doc-head h2 {
    margin: 3px 0 0;
    font-size: 18px;
    line-height: 1.3;
}
.wiki-doc-head code {
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--bg-code);
    color: var(--fg-tertiary);
    font-size: 9px;
}
.wiki-markdown {
    max-width: 780px;
    color: var(--fg-secondary);
    font-size: 13px;
    line-height: 1.7;
    overflow-wrap: anywhere;
    word-break: break-word;
}
.wiki-markdown :deep(h1),
.wiki-markdown :deep(h2),
.wiki-markdown :deep(h3),
.wiki-markdown :deep(h4) {
    color: var(--fg);
    line-height: 1.35;
}
.wiki-markdown :deep(h1) {
    font-size: 20px;
}
.wiki-markdown :deep(h2) {
    margin: 20px 0 7px;
    font-size: 15px;
}
.wiki-markdown :deep(h3) {
    margin: 16px 0 6px;
    font-size: 13px;
}
.wiki-markdown :deep(p) {
    margin: 8px 0;
}
.wiki-markdown :deep(a) {
    color: var(--accent);
}
.wiki-markdown :deep(code) {
    padding: 1px 4px;
    border-radius: 4px;
    background: var(--bg-code);
    font-size: 11px;
    white-space: pre-wrap;
}
.wiki-markdown :deep(pre) {
    padding: 10px;
    border-radius: var(--radius-sm);
    background: var(--bg-code);
    overflow-x: auto;
}
.wiki-markdown :deep(pre code) {
    padding: 0;
    background: transparent;
}
.wiki-markdown :deep(blockquote) {
    margin: 10px 0;
    padding: 7px 10px;
    border-left: 2px solid var(--accent);
    background: var(--accent-soft);
    color: var(--fg-secondary);
}
.wiki-markdown :deep(blockquote p) {
    margin: 0;
}
.wiki-markdown :deep(table) {
    width: 100%;
    border-collapse: collapse;
    margin: 10px 0;
    font-size: 11px;
}
.wiki-markdown :deep(th),
.wiki-markdown :deep(td) {
    padding: 6px 8px;
    border: 1px solid var(--border-soft);
    text-align: left;
    vertical-align: top;
}
.wiki-markdown :deep(th) {
    background: var(--bg);
    color: var(--fg);
}
.wiki-context {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.wiki-context-resizer {
    position: absolute;
    z-index: 2;
    top: 0;
    bottom: 0;
    left: -6px;
    width: 11px;
    padding: 0;
    border: none;
    border-radius: 0;
    background: transparent;
    cursor: col-resize;
}
.wiki-context-resizer::after {
    content: '';
    position: absolute;
    top: 40%;
    bottom: 40%;
    left: 5px;
    width: 2px;
    border-radius: 2px;
    background: var(--border);
}
.wiki-context-resizer:hover::after {
    background: var(--accent);
}
.wiki-context-card {
    padding: 10px;
}
.wiki-context-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    color: var(--fg-tertiary);
}
.wiki-context-head h3 {
    margin: 0;
    color: var(--fg);
    font-size: 12px;
}
.wiki-context-head code,
.wiki-claim-count {
    color: var(--fg-tertiary);
    font-size: 9px;
}
.wiki-text-button {
    border: none;
    background: transparent;
    color: var(--accent);
    padding: 0;
    font-size: 9px;
    cursor: pointer;
}
.wiki-claim-count {
    padding: 1px 6px;
    border-radius: 999px;
    background: var(--ok-soft);
    color: var(--ok);
}
.wiki-claim-count.warn {
    background: var(--warn-soft);
    color: var(--warn);
}
.wiki-purpose {
    margin: 8px 0;
    color: var(--fg-secondary);
    font-size: 11px;
    line-height: 1.55;
    overflow-wrap: anywhere;
}
.wiki-status-list,
.wiki-claims {
    list-style: none;
    margin: 0;
    padding: 0;
}
.wiki-status-list li {
    position: relative;
    margin: 5px 0;
    padding-left: 11px;
    color: var(--fg-secondary);
    font-size: 10px;
    line-height: 1.45;
    overflow-wrap: anywhere;
}
.wiki-status-list li::before {
    content: '';
    position: absolute;
    top: 6px;
    left: 1px;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--accent);
}
.wiki-claim-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 4px;
    margin: 8px 0;
}
.wiki-claim-grid div {
    display: flex;
    flex-direction: column;
    padding: 5px;
    border-radius: var(--radius-sm);
    background: var(--bg);
}
.wiki-claim-grid strong {
    font-size: 13px;
    font-variant-numeric: tabular-nums;
}
.wiki-claim-grid span {
    color: var(--fg-tertiary);
    font-size: 8px;
}
.wiki-claims li {
    display: flex;
    gap: 7px;
    padding: 6px 0;
    border-top: 1px solid var(--border-soft);
}
.wiki-claim-dot {
    flex: 0 0 auto;
    width: 6px;
    height: 6px;
    margin-top: 4px;
    border-radius: 50%;
    background: var(--ok);
}
.wiki-claim-dot.stale {
    background: var(--warn);
}
.wiki-claim-dot.missing {
    background: var(--error);
}
.wiki-claim-dot.retracted {
    background: var(--fg-tertiary);
}
.wiki-claims div {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
}
.wiki-claims strong {
    color: var(--fg-secondary);
    font-size: 10px;
    font-weight: 500;
    line-height: 1.4;
    overflow-wrap: anywhere;
}
.wiki-claims small {
    color: var(--fg-tertiary);
    font-size: 8px;
}
.wiki-provenance {
    display: flex;
    flex-direction: column;
    gap: 7px;
}
.wiki-root {
    color: var(--fg-secondary);
    font-size: 9px;
    overflow-wrap: anywhere;
}
.wiki-provenance p {
    margin: 0;
    color: var(--fg-tertiary);
    font-size: 9px;
    line-height: 1.45;
    overflow-wrap: anywhere;
}
.wiki-provenance p strong {
    margin-right: 5px;
    color: var(--fg-secondary);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
.wiki-background-sync.succeeded {
    color: var(--ok);
}
.wiki-background-sync.failed {
    color: var(--error);
}
.wiki-background-sync.queued,
.wiki-background-sync.running {
    color: var(--warn);
}
.wiki-background-sync-summary {
    margin-top: -2px !important;
    color: var(--fg-tertiary);
}
.wiki-background-sync-summary.error {
    color: var(--error);
}
.wiki-trace-state {
    padding: 1px 6px;
    border-radius: 999px;
    background: var(--bg-hover);
    color: var(--fg-tertiary);
    font-size: 8px;
    font-weight: 600;
}
.wiki-trace-state.running,
.wiki-trace-state.queued {
    background: var(--warn-soft);
    color: var(--warn);
}
.wiki-trace-state.approval {
    background: color-mix(in srgb, var(--warn) 18%, transparent);
    color: var(--warn);
}
.wiki-trace-state.succeeded {
    background: var(--ok-soft);
    color: var(--ok);
}
.wiki-trace-state.failed {
    background: var(--error-soft);
    color: var(--error);
}
.wiki-trace-meta {
    margin: 7px 0;
    color: var(--fg-tertiary);
    font-size: 9px;
    line-height: 1.45;
}
.wiki-trace-stalled {
    margin: 0 0 7px;
    color: var(--warn);
    font-size: 9px;
    line-height: 1.45;
}
.wiki-trace-stalled.approval {
    color: var(--warn);
    font-weight: 600;
}
.wiki-trace-list {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 210px;
    overflow-y: auto;
}
.wiki-trace-list li {
    display: grid;
    grid-template-columns: 58px minmax(0, 1fr);
    gap: 5px;
    padding: 4px 0;
    border-top: 1px solid var(--border-soft);
    font-size: 8px;
    line-height: 1.4;
}
.wiki-trace-list time {
    color: var(--fg-tertiary);
    font-variant-numeric: tabular-nums;
}
.wiki-trace-list span {
    color: var(--fg-secondary);
    overflow-wrap: anywhere;
}
.wiki-inline-approvals {
    display: flex;
    flex-direction: column;
    gap: 7px;
    margin: 8px 0;
    padding: 8px;
    border: 1px solid color-mix(in srgb, var(--warn) 45%, var(--border-soft));
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--warn) 8%, var(--bg));
}
.wiki-inline-approvals > strong {
    color: var(--warn);
    font-size: 10px;
}
.wiki-inline-approvals article {
    padding-top: 6px;
    border-top: 1px solid color-mix(in srgb, var(--warn) 25%, var(--border-soft));
}
.wiki-inline-approvals article:first-of-type {
    padding-top: 0;
    border-top: none;
}
.wiki-inline-approvals p {
    margin: 0 0 6px;
    max-height: 96px;
    overflow-y: auto;
    color: var(--fg-secondary);
    font-size: 9px;
    line-height: 1.45;
    white-space: pre-wrap;
}
.wiki-inline-approvals article > div {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 5px;
}
.wiki-inline-approvals article > div > span {
    margin-right: auto;
    color: var(--fg-tertiary);
    font-size: 8px;
}
.wiki-inline-approvals button {
    padding: 3px 6px;
    border-radius: 4px;
    font-size: 8px;
}
.wiki-live-stream {
    margin: 8px 0;
    padding: 8px;
    border-radius: var(--radius-sm);
    background: var(--thinking-soft);
}
.wiki-live-stream > div {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--thinking);
    font-size: 9px;
    font-weight: 600;
}
.wiki-live-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--thinking);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--thinking) 16%, transparent);
}
.wiki-live-stream pre {
    max-height: 190px;
    margin: 6px 0 0;
    overflow-y: auto;
    color: var(--fg-secondary);
    font-family: inherit;
    font-size: 9px;
    line-height: 1.5;
    white-space: pre-wrap;
}
.wiki-live-steps {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 8px 0 0;
    padding: 0;
    max-height: 320px;
    overflow-y: auto;
}
.wiki-live-step {
    padding: 7px;
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
    background: var(--bg);
}
.wiki-live-step.invocation {
    border-left: 2px solid var(--tool);
}
.wiki-live-step.deliberation {
    border-left: 2px solid var(--thinking);
}
.wiki-live-step-head {
    display: flex;
    justify-content: space-between;
    gap: 6px;
}
.wiki-live-step-head strong {
    font-size: 9px;
}
.wiki-live-step-head span {
    color: var(--fg-tertiary);
    font-size: 8px;
}
.wiki-live-step p,
.wiki-live-step pre {
    max-height: 150px;
    margin: 5px 0 0;
    overflow-y: auto;
    color: var(--fg-secondary);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 8px;
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}
.wiki-live-step.deliberation p {
    font-family: inherit;
    font-size: 9px;
}
.wiki-live-step .wiki-live-output {
    padding-top: 5px;
    border-top: 1px dashed var(--border-soft);
    color: var(--fg-secondary);
}
.wiki-muted {
    margin: 7px 0 0;
    color: var(--fg-tertiary);
    font-size: 10px;
}
.wiki-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 9px;
    padding: 24px;
    border: 1px dashed var(--border);
    border-radius: var(--radius-md);
    color: var(--fg-tertiary);
    text-align: center;
}
.wiki-empty strong {
    max-width: 560px;
    color: var(--fg-secondary);
    font-size: 13px;
    font-weight: 500;
}
.wiki-empty p {
    max-width: 560px;
    margin: 0;
    font-size: 11px;
    line-height: 1.6;
}
.wiki-empty code {
    padding: 1px 4px;
    border-radius: 4px;
    background: var(--bg-code);
    color: var(--fg-secondary);
}
.wiki-fact-mask {
    position: fixed;
    inset: 0;
    z-index: 80;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgba(15, 23, 42, 0.48);
}
.wiki-fact-dialog {
    width: min(760px, 94vw);
    max-height: min(720px, 86vh);
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 16px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--bg-panel);
    box-shadow: 0 18px 48px var(--shadow);
}
.wiki-fact-dialog > header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
}
.wiki-fact-dialog h2 {
    margin: 0;
    font-size: 17px;
}
.wiki-fact-dialog header p {
    margin: 2px 0 0;
    color: var(--fg-tertiary);
    font-size: 10px;
}
.wiki-fact-dialog header button {
    padding: 4px;
    border: none;
    background: transparent;
}
.wiki-fact-dialog-list {
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.wiki-fact-dialog-list > article {
    padding: 10px;
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
    background: var(--bg);
}
.wiki-fact-dialog-title {
    display: grid;
    grid-template-columns: 7px minmax(0, 1fr) auto;
    align-items: start;
    gap: 7px;
}
.wiki-fact-dialog-title strong {
    font-size: 12px;
    font-weight: 500;
}
.wiki-fact-dialog-title small {
    color: var(--fg-tertiary);
    font-size: 9px;
}
.wiki-fact-dialog-list > article > code {
    display: block;
    margin: 5px 0 0 14px;
    color: var(--fg-tertiary);
    font-size: 9px;
}
.wiki-fact-dialog-list ul {
    list-style: none;
    margin: 7px 0 0 14px;
    padding: 0;
}
.wiki-fact-dialog-list li {
    display: grid;
    grid-template-columns: 58px minmax(0, 1fr) auto;
    gap: 6px;
    padding: 4px 0;
    border-top: 1px solid var(--border-soft);
    color: var(--fg-tertiary);
    font-size: 9px;
}
.wiki-fact-dialog-list li code {
    color: var(--fg-secondary);
    overflow-wrap: anywhere;
}
.wiki-fact-dialog-list li em {
    color: var(--fg-tertiary);
    font-style: normal;
}
.wiki-fact-dialog-empty {
    color: var(--fg-tertiary);
    font-size: 11px;
}
.wiki-loading {
    border-style: solid;
}
@media (max-width: 1180px) {
    .wiki-layout {
        grid-template-columns: 200px minmax(0, 1fr);
    }
    .wiki-context {
        grid-column: 1 / -1;
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        overflow: visible;
    }
    .wiki-context-resizer {
        display: none;
    }
}
@media (max-width: 820px) {
    .wiki-kpis {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .wiki-layout {
        display: block;
        overflow-y: auto;
    }
    .wiki-current-panel {
        grid-template-columns: 1fr;
    }
    .wiki-nav,
    .wiki-content,
    .wiki-context {
        overflow: visible;
    }
    .wiki-nav {
        max-height: 230px;
        overflow-y: auto;
    }
    .wiki-content,
    .wiki-context {
        margin-top: 10px;
    }
    .wiki-context {
        display: flex;
    }
}
</style>
