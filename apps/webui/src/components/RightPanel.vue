<script setup>
import { computed, ref, watch } from 'vue';
import LineIcon from '../assets/LineIcon.vue';
import AuditDisclosure from './AuditDisclosure.vue';
import StoragePanel from './StoragePanel.vue';
import {
    donutArcs,
    formatBytes,
    formatCost,
    formatPercent,
    formatRate,
    formatSigned,
    formatTokens,
} from '../scripts/audit.ts';
import {
    ITERATION_STATUS_LABELS,
    ITERATION_STATUS_ORDER,
    TOC_STATUS_LABELS,
    buildIterationBoard,
    filterRecords,
    filterTocs,
    firstLineOf,
    iterationActions,
    iterationStatusTone,
    versionDetail,
    versionLabel,
} from '../scripts/iterations-view.ts';
import { renderMarkdown } from '../scripts/markdown.ts';
import { buildTraceBoard, filterTraceRuns } from '../scripts/trace.ts';
import {
    analyzeToc,
    copyThinkingChain,
    createIterationRecord,
    fetchLedger,
    iterationRecords,
    iterations,
    iterationsLoading,
    loadIterations,
    short,
    submitIterationFeedback,
    systemVersion,
    ui,
    updateIterationRecord,
    writeClipboard,
} from '../scripts/store.ts';

const props = defineProps({
    open: { type: Boolean, default: false },
    maximized: { type: Boolean, default: false },
    width: { type: Number, default: 320 },
    activeTab: { type: String, default: 'log' },
    current: { type: String, default: null },
    rootOutcome: { type: Object, default: null },
    busy: { type: Boolean, default: false },
    stepRows: { type: Array, default: () => [] },
    events: { type: Array, default: () => [] },
    filteredEvents: { type: Array, default: () => [] },
    eventTypes: { type: Array, default: () => [] },
    activeEventType: { type: String, default: 'all' },
    showAllEvents: { type: Boolean, default: false },
    /** buildAuditView() result for the selected Step/Task (docs/web/观测看板设计.md). */
    audit: { type: Object, default: null },
    /** 会话级 AuditView（buildAuditView 无选择时的结果）：Trace 看板的 rows / KPI 来源。 */
    trace: { type: Object, default: null },
    /** 会话内按顺序的 run（`{ runIndex, input }`）：Trace 列表的 Run 头标题。 */
    runs: { type: Array, default: () => [] },
});
const emit = defineEmits([
    'update:activeTab',
    'toggleMaximize',
    'collapse',
    'update:activeEventType',
    'toggleShowAll',
    'select-step',
    'locate-step',
    'select-conversation',
]);

function fmtClock(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
/**
 * 执行时刻：精确到毫秒。距今不超过一天 → HH:MM:SS.mmm；超过一天 → 带完整日期。
 */
function fmtPrecise(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
    const dayMs = 24 * 60 * 60 * 1000;
    if (Date.now() - ts > dayMs) {
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
    }
    return time;
}
function formatDuration(ms) {
    if (ms == null) return '';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}
function usageStats(usage) {
    if (!usage) return null;
    const v = usage.vendor || {};
    const input = v.inputTokens ?? 0;
    const output = v.outputTokens ?? 0;
    const cache = v.cacheReadInputTokens ?? 0;
    const reasoning = v.reasoningOutputTokens ?? 0;
    const total = input + output;
    return {
        input, output, cache, reasoning, total,
        context: usage.runtime?.totalContextTokens ?? null,
        hasData: total > 0 || cache > 0 || reasoning > 0,
    };
}
/* ---- 日志：任务执行失败账本（GET /api/ledger；系统日志不再占据右侧栏） ---- */
const FAILURE_KINDS = ['all', 'driver-error', 'max-steps', 'blocked-tool'];
const failureKind = ref('all');
const failures = ref([]);
const failuresLoading = ref(false);
const failuresError = ref('');

const failureRows = computed(() => {
    const list = failures.value || [];
    return failureKind.value === 'all' ? list : list.filter((row) => row.kind === failureKind.value);
});

/** 摘要 hover 弹窗（宽度不足时看全）。 */
const logTip = ref(null);
function showLogTip(event, text) {
    logTip.value = { text, x: event.clientX, y: event.clientY };
}
function hideLogTip() {
    logTip.value = null;
}

async function loadFailures() {
    failuresLoading.value = true;
    failuresError.value = '';
    try {
        failures.value = await fetchLedger({ limit: 500 });
    } catch (error) {
        failuresError.value = String(error);
    } finally {
        failuresLoading.value = false;
    }
}

watch(
    () => props.activeTab,
    (tab) => {
        if (tab === 'log') void loadFailures();
    },
    { immediate: true },
);


/* ---- Audit panel helpers (docs/web/观测看板设计.md v2) ---- */
function cacheHitRate(vendor) {
    const input = Number(vendor?.input ?? 0);
    return input > 0 ? formatPercent(Number(vendor?.cacheRead ?? 0) / input) : '0.0%';
}
function diffClass(delta) {
    if (delta === null || delta === undefined || delta === 0) return 'flat';
    return delta > 0 ? 'up' : 'down';
}
/** Task/Step 状态 → 颜色语义（成功/失败/中止/进行中）。 */
function statusClass(status) {
    const s = String(status ?? '').toLowerCase();
    if (s === 'succeeded' || s === 'success') return 'ok';
    if (s === 'failed' || s === 'error' || s === 'blocked') return 'bad';
    if (s === 'aborted' || s === 'cancelled' || s === 'canceled' || s === 'timeout') return 'warn';
    if (s === 'pending' || s === 'active' || s === 'running') return 'run';
    return '';
}
/* ---- 环形饼图 hover：扇区突出 + 气泡详情 ---- */
const donutWrap = ref(null);
const hoverKey = ref('');
const tipX = ref(0);
const tipY = ref(0);
const donutArcList = computed(() => donutArcs(props.audit?.segments || []));
const hoveredSegment = computed(
    () => (props.audit?.segments || []).find((seg) => seg.key === hoverKey.value) || null,
);
function onArcMove(event) {
    const el = donutWrap.value;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    tipX.value = event.clientX - rect.left + 12;
    tipY.value = event.clientY - rect.top + 12;
}
function onArcEnter(arc, event) {
    hoverKey.value = arc.key;
    onArcMove(event);
}
function onArcLeave() {
    hoverKey.value = '';
}
function vendorNonReasoning(vendor) {
    return Math.max(0, Number(vendor?.output ?? 0) - Number(vendor?.reasoning ?? 0));
}
function toFixed1(value) {
    const n = Number(value ?? 0);
    return Number.isFinite(n) ? n.toFixed(1) : '0.0';
}
/** 估算 input 成本采用的缓存命中率（旧数据/尚未上报时缺省 0.9）。 */
const estimateCachedRatio = computed(() => {
    const ratio = props.audit?.usage?.estimate?.cachedRatio;
    return typeof ratio === 'number' && Number.isFinite(ratio) ? ratio : 0.9;
});
const estimateCachedRatioLabel = computed(() => formatPercent(estimateCachedRatio.value));

/* ---- 分段落原文展开 ---- */
const openSegments = ref(new Set());
function toggleSegment(key) {
    const next = new Set(openSegments.value);
    next.has(key) ? next.delete(key) : next.add(key);
    openSegments.value = next;
}
/* ---- 审计折叠区块（context diff / Cost vendor / Cost 估算）：统一组件 + 统一事件 ---- */
const openSections = ref(new Set());
function toggleSection(key) {
    const next = new Set(openSections.value);
    next.has(key) ? next.delete(key) : next.add(key);
    openSections.value = next;
}
/* ---- Trace 看板（「审计」+「Context」合并，docs/web/观测看板设计.md v3） ---- */
const TRACE_FILTERS = [
    { key: 'all', label: '全部' },
    { key: 'model', label: '模型' },
    { key: 'tool', label: '工具' },
    { key: 'error', label: '异常' },
];
/** 列表视图：时间瀑布 / Context 增长条。 */
const traceMode = ref('timeline');
const traceFilter = ref('all');
/** 会话级看板（不随 Step/Task 选择变化）。 */
const traceBoard = computed(() =>
    buildTraceBoard({
        rows: props.trace?.rows ?? [],
        usage: props.trace?.usage ?? null,
        tasks: props.trace?.tasks ?? [],
        runs: props.runs ?? [],
    }),
);
const traceSummary = computed(() => traceBoard.value.summary);
const traceRuns = computed(() => filterTraceRuns(traceBoard.value.runs, traceFilter.value));
/** Run / Task 两级折叠态（默认展开）。 */
const collapsedRuns = ref(new Set());
const collapsedTasks = ref(new Set());
function toggleRun(key) {
    const next = new Set(collapsedRuns.value);
    next.has(key) ? next.delete(key) : next.add(key);
    collapsedRuns.value = next;
}
function toggleTask(key) {
    const next = new Set(collapsedTasks.value);
    next.has(key) ? next.delete(key) : next.add(key);
    collapsedTasks.value = next;
}
/** 列表渲染项：Run 头 → Task 头 → 展平的 span（工具子步 depth 1）。 */
const traceItems = computed(() => {
    const items = [];
    for (const run of traceRuns.value) {
        items.push({ kind: 'run', key: run.key, run });
        if (collapsedRuns.value.has(run.key)) continue;
        for (const task of run.tasks) {
            items.push({ kind: 'task', key: task.key, task });
            if (collapsedTasks.value.has(task.key)) continue;
            for (const span of task.spans) {
                items.push({ kind: 'span', key: span.stepId, span, depth: 0 });
                for (const child of span.children) {
                    items.push({ kind: 'span', key: child.stepId, span: child, depth: 1 });
                }
            }
        }
    }
    return items;
});
const traceUtilization = computed(() => props.trace?.utilization ?? null);
const traceWindowTokens = computed(() => props.trace?.contextWindowTokens ?? null);

/** 缓存命中率：无 input 时显示占位符。 */
function hitRateLabel(rate) {
    return rate == null ? '—' : formatPercent(rate);
}
/** trace 级吞吐（output token / 秒），对齐 Langfuse 的 latency 卡片副标题。 */
const traceThroughput = computed(() => {
    const { outputTokens, durationMs } = traceSummary.value;
    if (!durationMs || durationMs <= 0 || !outputTokens) return null;
    return (outputTokens / durationMs) * 1000;
});
/** span 行展开态：模型步看 context diff，工具步看命令与输出。 */
const openSpans = ref(new Set());
function toggleSpan(stepId) {
    const next = new Set(openSpans.value);
    next.has(stepId) ? next.delete(stepId) : next.add(stepId);
    openSpans.value = next;
}
/* ---- Output 分段（reasoning / tool-call args / text） ---- */
const openOutput = ref(false);
const outputSegments = computed(() => {
    const out = props.audit?.output;
    if (!out) return [];
    const total = out.reasoningTokens + out.toolCallArgsTokens + out.textTokens;
    const denom = total > 0 ? total : 1;
    return [
        { key: 'reasoning', label: 'reasoning', tokens: out.reasoningTokens, colorVar: '--seg-assistant' },
        { key: 'toolCallArgs', label: 'tool-call args', tokens: out.toolCallArgsTokens, colorVar: '--seg-toolcall' },
        { key: 'text', label: 'text', tokens: out.textTokens, colorVar: '--seg-input' },
    ].map((seg) => ({
        ...seg,
        ratio: seg.tokens / denom,
        width: (seg.tokens / denom) * 100,
    }));
});
const outputContent = computed(() => {
    const contents = props.audit?.output?.contents;
    if (!contents) return '';
    return [
        contents.reasoning ? `[reasoning]\n${contents.reasoning}` : '',
        contents.toolCalls ? `[tool-call args]\n${contents.toolCalls}` : '',
        contents.text ? `[text]\n${contents.text}` : '',
    ]
        .filter((part) => part.length > 0)
        .join('\n\n');
});
function toggleOutput() {
    openOutput.value = !openOutput.value;
}
function pricingRate(perMTok) {
    // 与 formatCost 同币种符号（本项目计价口径为元）。
    return `¥${perMTok}/M`;
}

/* ---- TOC / Iterations：冻结 thinking 链 → 独立分析 → 反馈 ---- */
const analyzeOpen = ref(false);
const analyzeInput = ref('');
const analyzeModel = ref('');
const analyzeTarget = ref(null);
const analyzeBusy = ref(false);
const copiedToc = ref(false);
const tocMenuOpen = ref(false);
const feedbackDrafts = ref({});
let copiedTimer = null;

/** 步骤明细只含单一 Task 时，该 Task 才是可 Copy/Analyze 的 TOC 目标。 */
const tocTarget = computed(() => {
    const rows = props.audit?.rows || [];
    if (rows.length === 0) return null;
    const taskId = rows[0].taskId;
    if (!taskId || rows.some((row) => row.taskId !== taskId)) return null;
    return {
        taskId,
        goalId: rows[0].goalId || '',
        // 历史 run 的 task 必须用它自己所属的 rootGoalId，而不是当前打开的 run。
        rootGoalId: rows[0].rootGoalId || props.current || '',
    };
});

function toggleTocMenu() {
    tocMenuOpen.value = !tocMenuOpen.value;
}
function copyFromMenu(target) {
    tocMenuOpen.value = false;
    void copyToc(target);
}
function analyzeFromMenu(target) {
    tocMenuOpen.value = false;
    openAnalyze(target);
}
function openAnalyze(target) {
    if (!target) return;
    analyzeTarget.value = target;
    analyzeInput.value = '';
    analyzeModel.value = '';
    analyzeOpen.value = true;
}
function closeAnalyze() {
    analyzeOpen.value = false;
    analyzeBusy.value = false;
}
async function runAnalyze() {
    const target = analyzeTarget.value;
    const rootGoalId = target?.rootGoalId || props.current;
    if (!target || !rootGoalId) return;
    analyzeBusy.value = true;
    try {
        await analyzeToc({
            taskId: target.taskId,
            goalId: target.goalId,
            rootGoalId,
            userInput: analyzeInput.value.trim(),
            ...(analyzeModel.value.trim() ? { modelId: analyzeModel.value.trim() } : {}),
            ...(target.tocId ? { tocId: target.tocId } : {}),
        });
        closeAnalyze();
        emit('update:activeTab', 'iterations');
    } catch (error) {
        ui.err = String(error);
        analyzeBusy.value = false;
    }
}
async function copyToc(target) {
    const rootGoalId = target?.rootGoalId || props.current;
    if (!target || !rootGoalId) return;
    try {
        await copyThinkingChain(rootGoalId, target.taskId);
        copiedToc.value = true;
        if (copiedTimer) clearTimeout(copiedTimer);
        copiedTimer = setTimeout(() => {
            copiedToc.value = false;
        }, 1500);
    } catch (error) {
        ui.err = String(error);
    }
}
function feedbackDraft(analyzeId) {
    return feedbackDrafts.value[analyzeId] || '';
}
function setFeedbackDraft(analyzeId, text) {
    feedbackDrafts.value = { ...feedbackDrafts.value, [analyzeId]: text };
}
async function submitFeedback(analyzeId) {
    const content = feedbackDraft(analyzeId).trim();
    if (!content) return;
    try {
        await submitIterationFeedback(analyzeId, { content });
        setFeedbackDraft(analyzeId, '');
    } catch (error) {
        ui.err = String(error);
    }
}

/* ---- Iterations 面板（docs/web/迭代面板设计.md v1）：思维链 / 迭代记录 / 系统 ---- */
const ITERATION_SECTIONS = [
    { key: 'toc', label: '思维链' },
    { key: 'records', label: '迭代记录' },
    { key: 'system', label: '系统' },
];
const TOC_STATUS_FILTERS = [
    { key: 'all', label: '全部' },
    { key: 'succeeded', label: '成功' },
    { key: 'failed', label: '失败' },
    { key: 'none', label: '未分析' },
];
const RECORD_STATUS_FILTERS = [
    { key: 'all', label: '全部' },
    ...ITERATION_STATUS_ORDER.map((status) => ({ key: status, label: ITERATION_STATUS_LABELS[status] })),
];
const iterationSection = ref('toc');
const tocQuery = ref('');
const tocStatusFilter = ref('all');
const recordStatusFilter = ref('all');
const selectedTocId = ref('');
const openTocText = ref(new Set());
const openRecordId = ref('');
const recordDrafts = ref({});
const busyAnalyzeId = ref('');

/** TOC 聚合 + 迭代记录 + 计数。 */
const iterationBoard = computed(() =>
    buildIterationBoard({
        iterations: iterations.value,
        records: iterationRecords.value,
    }),
);
const visibleTocs = computed(() =>
    filterTocs(iterationBoard.value.tocs, { query: tocQuery.value, status: tocStatusFilter.value }),
);
const visibleRecords = computed(() =>
    filterRecords(iterationBoard.value.records, recordStatusFilter.value),
);
/** 详情选中项：按 board 行取（不受列表过滤影响），原文/taskId 从原始记录取。 */
const selectedToc = computed(
    () => iterationBoard.value.tocs.find((row) => row.tocId === selectedTocId.value) ?? null,
);
const selectedTocRecord = computed(
    () => iterations.value.find((item) => item.toc.tocId === selectedTocId.value)?.toc ?? null,
);

function openToc(tocId) {
    selectedTocId.value = tocId;
}
function backToTocList() {
    selectedTocId.value = '';
}
function toggleTocText(tocId) {
    const next = new Set(openTocText.value);
    next.has(tocId) ? next.delete(tocId) : next.add(tocId);
    openTocText.value = next;
}
function toggleRecord(iterationId) {
    openRecordId.value = openRecordId.value === iterationId ? '' : iterationId;
}
/** 从迭代记录回到来源思维链详情（清空过滤，避免目标被筛掉）。 */
function selectTocFromRecord(row) {
    if (!row.tocId) return;
    iterationSection.value = 'toc';
    tocQuery.value = '';
    tocStatusFilter.value = 'all';
    selectedTocId.value = row.tocId;
}
/** 从报告跳回其迭代记录：切到记录页并展开该条。 */
function jumpToRecord(iterationId) {
    iterationSection.value = 'records';
    recordStatusFilter.value = 'all';
    openRecordId.value = iterationId;
}
/** 采纳报告为迭代项：标题取分析诉求首行，缺省用 TOC 短号。 */
async function adoptAnalysis(tocRow, analysisRow) {
    if (analysisRow.record || busyAnalyzeId.value) return;
    busyAnalyzeId.value = analysisRow.analysis.analyzeId;
    try {
        await createIterationRecord({
            title:
                firstLineOf(analysisRow.analysis.userInput, 80) || `TOC ${tocRow.shortId} 的改进`,
            analyzeId: analysisRow.analysis.analyzeId,
            tocId: tocRow.tocId,
        });
    } catch (error) {
        ui.err = String(error);
    } finally {
        busyAnalyzeId.value = '';
    }
}
async function runIterationAction(record, action) {
    try {
        await updateIterationRecord(record.iterationId, { status: action.next });
    } catch (error) {
        ui.err = String(error);
    }
}
function recordDraft(iterationId, fallback) {
    return recordDrafts.value[iterationId] ?? fallback ?? '';
}
function setRecordDraft(iterationId, text) {
    recordDrafts.value = { ...recordDrafts.value, [iterationId]: text };
}
async function saveRecordNotes(record) {
    try {
        await updateIterationRecord(record.iterationId, {
            notes: recordDraft(record.iterationId, record.notes),
        });
    } catch (error) {
        ui.err = String(error);
    }
}
async function copyReport(text) {
    try {
        await writeClipboard(String(text ?? ''));
    } catch (error) {
        ui.err = String(error);
    }
}
/** 复用同一 TOC 再分析（需回原始记录取 task/goal/rootGoalId）。 */
function reanalyzeToc(tocRow) {
    const toc = iterations.value.find((item) => item.toc.tocId === tocRow.tocId)?.toc;
    if (!toc) return;
    openAnalyze({
        taskId: toc.taskId,
        goalId: toc.goalId,
        rootGoalId: toc.rootGoalId,
        tocId: toc.tocId,
    });
}
/** 复制该 TOC 的 thinking 链（与对话流 Task 头等价）。 */
async function copyTocChain(tocRow) {
    const toc = iterations.value.find((item) => item.toc.tocId === tocRow.tocId)?.toc;
    if (!toc) return;
    try {
        await copyThinkingChain(toc.rootGoalId, toc.taskId);
    } catch (error) {
        ui.err = String(error);
    }
}
watch(
    () => props.activeTab,
    (tab) => {
        if (tab === 'iterations') void loadIterations();
    },
);
</script>

<template>
    <aside
        class="right-panel"
        :class="{ open, maximized }"
        :style="open && !maximized ? { width: width + 'px', minWidth: width + 'px' } : {}"
    >
        <button v-if="open && !maximized" class="right-panel-handle" title="收起面板" @click="emit('collapse')">
            <LineIcon name="chevronRight" size="12" />
        </button>
        <div class="right-panel-inner">
            <div class="drawer-head">
                <div class="drawer-tabs">
                    <button :class="{ on: activeTab === 'trace' }" @click="emit('update:activeTab', 'trace')">Trace</button>
                    <button :class="{ on: activeTab === 'iterations' }" @click="emit('update:activeTab', 'iterations')">Iterations</button>
                    <button :class="{ on: activeTab === 'log' }" @click="emit('update:activeTab', 'log')">日志</button>
                    <button :class="{ on: activeTab === 'storage' }" @click="emit('update:activeTab', 'storage')">存储</button>
                </div>
                <div class="drawer-head-actions">
                    <button class="icon-btn" :title="maximized ? '还原' : '最大化'" @click="emit('toggleMaximize')">
                        <LineIcon :name="maximized ? 'minimize' : 'maximize'" size="14" />
                    </button>
                </div>
            </div>

            <div v-if="activeTab === 'trace' && audit" class="drawer-body audit-body trace-body">
                <!-- Trace KPI 概览：面板最上面，会话级事实，不随 Step/Task 选择变化 -->
                <section class="trace-kpi">
                    <div class="trace-kpi-card">
                        <span class="trace-kpi-label">步骤</span>
                        <span class="trace-kpi-value">{{ traceSummary.steps }}</span>
                        <span class="trace-kpi-sub">{{ traceSummary.modelSteps }} 模型 · {{ traceSummary.toolSteps }} 工具<template v-if="traceSummary.errorSteps"> · {{ traceSummary.errorSteps }} 异常</template></span>
                    </div>
                    <div class="trace-kpi-card">
                        <span class="trace-kpi-label">input</span>
                        <span class="trace-kpi-value">{{ formatTokens(traceSummary.inputTokens) }}</span>
                        <span class="trace-kpi-sub">cached {{ formatTokens(traceSummary.cacheReadTokens) }}</span>
                    </div>
                    <div class="trace-kpi-card">
                        <span class="trace-kpi-label">output</span>
                        <span class="trace-kpi-value">{{ formatTokens(traceSummary.outputTokens) }}</span>
                        <span class="trace-kpi-sub">缓存命中 {{ hitRateLabel(traceSummary.cacheHitRate) }}</span>
                    </div>
                    <div class="trace-kpi-card">
                        <span class="trace-kpi-label">成本</span>
                        <span class="trace-kpi-value">{{ formatCost(traceSummary.costUsd) }}</span>
                        <span class="trace-kpi-sub">vendor 实付</span>
                    </div>
                    <div class="trace-kpi-card">
                        <span class="trace-kpi-label">耗时</span>
                        <span class="trace-kpi-value">{{ formatDuration(traceSummary.durationMs) || '—' }}</span>
                        <span class="trace-kpi-sub">{{ traceThroughput != null ? toFixed1(traceThroughput) + ' tok/s' : 'trace' }}</span>
                    </div>
                </section>

                <div class="audit-head">
                    <div class="audit-head-main">
                        <div class="audit-title">
                            {{ audit.title }}
                            <span v-if="audit.status" class="audit-status" :class="statusClass(audit.status)">{{ audit.status }}</span>
                            <span v-if="audit.taskStatus" class="audit-status task" :class="statusClass(audit.taskStatus)">task: {{ audit.taskStatus }}</span>
                        </div>
                        <div v-if="audit.subtitle" class="audit-subtitle">{{ audit.subtitle }}</div>
                    </div>
                    <div
                        v-if="audit.startedAt"
                        class="audit-head-start"
                        :title="'执行开始时间：' + fmtPrecise(audit.startedAt)"
                    >{{ fmtPrecise(audit.startedAt) }}</div>
                    <span v-if="tocTarget" class="toc-menu">
                        <button
                            class="toc-menu-trigger"
                            :class="{ copied: copiedToc }"
                            title="TOC"
                            @click.stop="toggleTocMenu()"
                        >
                            <LineIcon name="more" size="14" />
                        </button>
                        <span v-if="tocMenuOpen" class="toc-menu-pop">
                            <button @click.stop="copyFromMenu(tocTarget)">{{ copiedToc ? 'Copied' : 'Copy' }}</button>
                            <button @click.stop="analyzeFromMenu(tocTarget)">Analyze</button>
                        </span>
                    </span>
                    <button
                        class="audit-info-btn"
                        :class="{ on: audit.kind === 'conversation' }"
                        title="会话汇总（清空 Step/Task 选择）"
                        @click="emit('select-conversation')"
                    >
                        <LineIcon name="info" size="14" />
                    </button>
                </div>

                <!-- Trace 列表：时间线 / Context 两种视图，单击选中、双击定位 -->
                <section v-if="maximized" class="audit-section trace-list">
                    <div class="audit-section-title">
                        <span>Trace</span>
                        <span class="audit-pct">{{ traceRuns.length }} run · {{ traceSummary.steps }} span</span>
                    </div>

                    <div class="trace-toolbar">
                        <button
                            v-for="item in TRACE_FILTERS"
                            :key="item.key"
                            class="trace-chip"
                            :class="{ on: traceFilter === item.key }"
                            @click="traceFilter = item.key"
                        >{{ item.label }}</button>
                        <span class="trace-toolbar-gap"></span>
                        <button class="trace-chip" :class="{ on: traceMode === 'timeline' }" @click="traceMode = 'timeline'">时间线</button>
                        <button class="trace-chip" :class="{ on: traceMode === 'context' }" @click="traceMode = 'context'">Context</button>
                    </div>

                    <div v-if="traceMode === 'context'" class="ctx-summary">
                        <span>峰值 {{ formatTokens(traceBoard.peakContext) }}</span>
                        <span>最新 {{ formatTokens(traceBoard.latestContext) }}</span>
                        <span v-if="traceUtilization != null">窗口利用率 {{ formatPercent(traceUtilization) }}<template v-if="traceWindowTokens"> · {{ formatTokens(traceWindowTokens) }} tok</template></span>
                    </div>
                    <div v-if="traceMode === 'context'" class="ctx-legend">
                        <span v-for="seg in traceBoard.legend" :key="seg.key" class="ctx-legend-item">
                            <span class="seg-dot" :style="{ background: 'var(' + seg.colorVar + ')' }"></span>{{ seg.label }}
                        </span>
                    </div>

                    <div class="trace-groups">
                        <template v-for="item in traceItems" :key="item.key">
                            <button
                                v-if="item.kind === 'run'"
                                class="trace-run-head"
                                :title="collapsedRuns.has(item.run.key) ? '展开该 Run' : '折叠该 Run'"
                                @click="toggleRun(item.run.key)"
                            >
                                <span class="trace-head-caret">{{ collapsedRuns.has(item.run.key) ? '+' : '−' }}</span>
                                <span class="trace-run-loc">R#{{ item.run.runIndex }}</span>
                                <span class="trace-run-title">{{ item.run.title || 'Run' }}</span>
                                <span class="trace-head-meta">{{ item.run.stepCount }} 步 · {{ formatDuration(item.run.durationMs) || '—' }}</span>
                            </button>
                            <button
                                v-else-if="item.kind === 'task'"
                                class="trace-task-head"
                                :title="collapsedTasks.has(item.task.key) ? '展开该 Task' : '折叠该 Task'"
                                @click="toggleTask(item.task.key)"
                            >
                                <span class="trace-head-caret">{{ collapsedTasks.has(item.task.key) ? '+' : '−' }}</span>
                                <span class="trace-task-loc">R#{{ item.task.runIndex }}·T#{{ item.task.taskIndex }}</span>
                                <span class="trace-task-title">{{ item.task.title || 'Task' }}</span>
                                <span class="audit-status" :class="statusClass(item.task.status)">{{ item.task.status }}</span>
                                <span class="trace-head-meta">{{ item.task.stepCount }} 步 · {{ formatDuration(item.task.durationMs) || '—' }}</span>
                            </button>
                            <div v-else class="trace-item">
                                <div
                                    class="trace-span"
                                    :class="{ selected: item.span.selected, tool: item.span.isTool, error: item.span.isError, child: item.depth > 0 }"
                                    title="单击选中 · 双击定位会话流"
                                    @click="emit('select-step', { stepId: item.span.stepId, taskId: item.span.taskId })"
                                    @dblclick="emit('locate-step', { stepId: item.span.stepId, taskId: item.span.taskId })"
                                >
                                    <span
                                        class="trace-caret"
                                        :class="{ open: openSpans.has(item.span.stepId) }"
                                        :title="openSpans.has(item.span.stepId) ? '折叠' : '展开'"
                                        @click.stop="toggleSpan(item.span.stepId)"
                                    >{{ openSpans.has(item.span.stepId) ? '−' : '+' }}</span>
                                    <span class="trace-loc">{{ item.span.loc }}</span>
                                    <span class="trace-kind" :class="{ tool: item.span.isTool }">{{ item.span.kindLabel }}</span>
                                    <span class="trace-bar">
                                        <template v-if="traceMode === 'timeline'">
                                            <span
                                                class="trace-bar-fill"
                                                :style="{ left: item.span.timeline.left + '%', width: item.span.timeline.width + '%' }"
                                            ></span>
                                        </template>
                                        <template v-else-if="item.span.context.width > 0">
                                            <span class="ctx-bar-fill" :style="{ width: item.span.context.width + '%' }">
                                                <span
                                                    v-for="seg in item.span.segments"
                                                    :key="seg.key"
                                                    class="ctx-seg"
                                                    :style="{ width: seg.width + '%', background: 'var(' + seg.colorVar + ')' }"
                                                    :title="seg.label + ' · ' + formatTokens(seg.tokens)"
                                                ></span>
                                            </span>
                                        </template>
                                    </span>
                                    <span class="trace-tokens">{{ item.span.tokens ? formatTokens(item.span.tokens) : '-' }}</span>
                                    <span class="trace-delta" :class="diffClass(item.span.contextDelta)">{{ formatSigned(item.span.contextDelta) }}</span>
                                </div>
                                <div v-if="openSpans.has(item.span.stepId)" class="ctx-diff" @click.stop @dblclick.stop>
                                    <template v-if="item.span.isTool">
                                        <div class="ctx-diff-label">命令 / 参数</div>
                                        <pre class="seg-content">{{ item.span.toolLine || '(无)' }}</pre>
                                        <div class="ctx-diff-label">输出</div>
                                        <pre class="seg-content">{{ item.span.toolOutput || '(空)' }}</pre>
                                    </template>
                                    <template v-else>
                                        <template v-for="part in item.span.diffParts" :key="part.key">
                                            <div class="ctx-diff-label">{{ part.label }}</div>
                                            <pre class="seg-content">{{ part.text }}</pre>
                                        </template>
                                        <div v-if="!item.span.diffParts.length" class="audit-muted">（本步无新增内容）</div>
                                    </template>
                                </div>
                            </div>
                        </template>
                        <div v-if="!traceItems.length" class="audit-muted">暂无可追踪的步骤</div>
                    </div>
                </section>

                <div v-if="audit.kind === 'none'" class="empty-hint trace-detail">
                    {{ audit.stale ? '目标已失效，请重新选择 Step 或 Task' : '点击对话流中的 Step 或 Task 查看可观测事实' }}
                </div>

                <div v-else class="trace-detail">
                    <!-- 工具调用：专用审计 view（命令/参数/输出/耗时），不显示 vendor token -->
                    <section v-if="audit.tool" class="audit-section">
                        <div class="audit-section-title">工具调用 · {{ audit.tool.name }}</div>
                        <div class="audit-row"><span class="audit-key">工作路径 / 命令</span><span class="audit-val audit-mono">{{ audit.tool.line || audit.tool.name }}</span></div>
                        <div v-if="audit.tool.arguments && Object.keys(audit.tool.arguments).length" class="audit-tool-block">
                            <div class="audit-key">参数</div>
                            <pre class="seg-content">{{ JSON.stringify(audit.tool.arguments, null, 2) }}</pre>
                        </div>
                        <div class="audit-row"><span class="audit-key">耗时</span><span class="audit-val">{{ formatDuration(audit.tool.durationMs) || '-' }}</span></div>
                        <div v-if="audit.startedAt" class="audit-row"><span class="audit-key">开始</span><span class="audit-val">{{ fmtPrecise(audit.startedAt) }}</span></div>
                        <div class="audit-row"><span class="audit-key">状态</span><span class="audit-val" :class="{ 'audit-warn': audit.tool.isError }">{{ audit.tool.status }}</span></div>
                        <div class="audit-tool-block">
                            <div class="audit-key">输出</div>
                            <pre class="seg-content audit-tool-output">{{ audit.tool.output || '(空)' }}</pre>
                        </div>
                    </section>
                    <template v-else>
                    <!-- Vendor 实际 -->
                    <section class="audit-section">
                        <div class="audit-section-title">Vendor 用量</div>
                        <template v-if="audit.usage.vendor">
                            <div class="audit-row"><span class="audit-key">input</span><span class="audit-val">{{ formatTokens(audit.usage.vendor.input) }}</span></div>
                            <div class="audit-row"><span class="audit-key">output</span><span class="audit-val">{{ formatTokens(audit.usage.vendor.output) }}</span></div>
                            <div v-if="audit.usage.vendor.cacheRead" class="audit-row">
                                <span class="audit-key">cached input</span>
                                <span class="audit-val">{{ formatTokens(audit.usage.vendor.cacheRead) }} <span class="audit-note-inline">{{ cacheHitRate(audit.usage.vendor) }}</span></span>
                            </div>
                            <div v-if="audit.usage.vendor.cacheCreation" class="audit-row"><span class="audit-key">cache write</span><span class="audit-val">{{ formatTokens(audit.usage.vendor.cacheCreation) }}</span></div>
                            <div class="audit-row"><span class="audit-key">reasoning output</span><span class="audit-val">{{ formatTokens(audit.usage.vendor.reasoning) }}</span></div>
                            <div class="audit-row audit-total"><span class="audit-key">total</span><span class="audit-val">{{ formatTokens(audit.usage.vendor.total) }}</span></div>
                        </template>
                        <div v-else class="audit-muted">厂商未上报</div>
                    </section>

                    <!-- Input 估算（breakdown）：环形饼图 + 占比 + diff + 漂移 -->
                    <section class="audit-section">
                        <div class="audit-section-title">
                            <span>Input breakdown</span>
                            <span v-if="audit.utilization != null" class="audit-title-meta">窗口使用率 {{ formatPercent(audit.utilization) }}<template v-if="audit.contextWindowTokens"> · {{ formatTokens(audit.contextWindowTokens) }} tok</template></span>
                        </div>
                        <template v-if="audit.segments.length">
                            <div ref="donutWrap" class="donut-wrap" @mouseleave="onArcLeave">
                                <svg class="donut-svg" viewBox="0 0 100 100" role="img" aria-label="context 占比">
                                    <path
                                        v-for="arc in donutArcList"
                                        :key="arc.key"
                                        class="donut-arc"
                                        :class="{ dim: hoverKey && hoverKey !== arc.key }"
                                        :d="arc.path"
                                        :style="{
                                            '--arc-color': 'var(' + arc.colorVar + ')',
                                            ...(hoverKey === arc.key ? { transform: 'translate(' + arc.offset.x + 'px,' + arc.offset.y + 'px)' } : {}),
                                        }"
                                        @mouseenter="onArcEnter(arc, $event)"
                                        @mousemove="onArcMove"
                                    />
                                </svg>
                                <div class="donut-hole">
                                    <span class="donut-num">{{ formatTokens(audit.usage.runtime ? audit.usage.runtime.totalContextTokens : null) }}</span>
                                    <span class="donut-cap">估算 input</span>
                                </div>
                                <div v-if="hoveredSegment" class="donut-tip" :style="{ left: tipX + 'px', top: tipY + 'px' }">
                                    <div class="donut-tip-title">
                                        <span class="seg-dot" :style="{ background: 'var(' + hoveredSegment.colorVar + ')' }"></span>
                                        {{ hoveredSegment.label }}
                                    </div>
                                    <div class="donut-tip-row">tokens {{ formatTokens(hoveredSegment.tokens) }}</div>
                                    <div class="donut-tip-row">占比 {{ formatPercent(hoveredSegment.ratio) }}</div>
                                </div>
                            </div>
                            <template v-for="seg in audit.segments" :key="seg.key">
                                <button
                                    class="seg-row"
                                    :class="{ open: openSegments.has(seg.key), hot: hoverKey === seg.key }"
                                    :title="'查看 ' + seg.label + ' 原文'"
                                    @mouseenter="hoverKey = seg.key"
                                    @mouseleave="hoverKey = ''"
                                    @click="toggleSegment(seg.key)"
                                >
                                    <span class="seg-dot" :style="{ background: 'var(' + seg.colorVar + ')' }"></span>
                                    <span class="seg-label">{{ seg.label }}</span>
                                    <span class="seg-tokens">{{ formatTokens(seg.tokens) }}</span>
                                    <span class="seg-ratio">{{ formatPercent(seg.ratio) }}</span>
                                    <span class="seg-caret"><LineIcon :name="openSegments.has(seg.key) ? 'chevronDown' : 'chevronRight'" size="10" /></span>
                                </button>
                                <pre v-if="openSegments.has(seg.key)" class="seg-content">{{ seg.content || '（无原文）' }}</pre>
                            </template>
                        </template>
                        <div v-else class="audit-muted">Runtime 未采集</div>

                        <AuditDisclosure
                            v-if="audit.diff || audit.diffParts.length"
                            label="context diff"
                            :open="openSections.has('contextDiff')"
                            title="本步估算 context 总量 − 会话流中上一步的估算 context 总量；点击展开相对上一轮的新增内容"
                            @toggle="toggleSection('contextDiff')"
                        >
                            <span v-if="audit.diff" class="audit-diff" :class="diffClass(audit.diff.delta)">
                                {{ formatSigned(audit.diff.delta) }}({{ formatTokens(audit.diff.from) }} → {{ formatTokens(audit.diff.to) }})
                            </span>
                            <span v-else class="audit-note-inline">{{ audit.diffParts.length }} 段新增</span>
                            <template #body>
                                <template v-for="part in audit.diffParts" :key="part.key">
                                    <div class="ctx-diff-label">{{ part.label }}</div>
                                    <pre class="seg-content">{{ part.text }}</pre>
                                </template>
                                <div v-if="!audit.diffParts.length" class="audit-muted">（本步无新增内容）</div>
                            </template>
                        </AuditDisclosure>

                        <div v-if="audit.usage.runtime" class="audit-row">
                            <span class="audit-key" title="input 漂移 = 本轮 tokenizer 估算 input − 本轮 vendor 上报 input（与上方饼图同一轮）；正=高估，负=低估">input 漂移</span>
                            <span class="audit-val" :class="diffClass(audit.usage.latestInputDrift)">
                                {{ formatTokens(audit.usage.runtime.totalContextTokens) }}<template v-if="audit.usage.latestVendorInput != null"> · vendor {{ formatTokens(audit.usage.latestVendorInput) }}({{ formatSigned(audit.usage.latestInputDrift) }}<span class="audit-note-inline">{{ formatRate(audit.usage.latestInputDriftRate) }}</span>)</template>
                            </span>
                        </div>

                        <div v-if="audit.strategies.length" class="audit-note">策略：{{ audit.strategies.join(' · ') }}</div>
                        <div v-if="audit.budgetPressureAction" class="audit-note audit-warn">预算压力：{{ audit.budgetPressureAction }}</div>
                    </section>

                    <!-- Output 分段（reasoning / tool-call args / text） -->
                    <section class="audit-section">
                        <div class="audit-section-title">Output breakdown</div>
                        <template v-if="outputSegments.length">
                            <div class="output-bar">
                                <span
                                    v-for="seg in outputSegments"
                                    :key="seg.key"
                                    class="output-seg"
                                    :style="{ width: seg.width + '%', background: 'var(' + seg.colorVar + ')' }"
                                    :title="seg.label + ' · ' + formatTokens(seg.tokens)"
                                ></span>
                            </div>
                            <button
                                v-for="seg in outputSegments"
                                :key="seg.key"
                                class="seg-row"
                                :class="{ open: openOutput }"
                                @click="toggleOutput"
                            >
                                <span class="seg-dot" :style="{ background: 'var(' + seg.colorVar + ')' }"></span>
                                <span class="seg-label">{{ seg.label }}</span>
                                <span class="seg-tokens">{{ formatTokens(seg.tokens) }}</span>
                                <span class="seg-ratio">{{ formatPercent(seg.ratio) }}</span>
                            </button>
                            <div class="audit-row audit-total">
                                <span class="audit-key">total</span>
                                <span class="audit-val">
                                    {{ formatTokens(audit.output.totalOutputTokens) }}
                                    <span v-if="audit.usage.vendor" class="audit-note-inline">
                                        · vendor {{ formatTokens(audit.usage.vendor.output) }}
                                        （差 {{ formatSigned(audit.output.totalOutputTokens - audit.usage.vendor.output) }}）
                                    </span>
                                </span>
                            </div>
                            <pre v-if="openOutput && outputContent" class="seg-content">{{ outputContent }}</pre>
                        </template>
                        <div v-else class="audit-muted">无输出分段</div>
                    </section>

                    <!-- Cost 双口径：默认只列 vendor / 估算，点行展开明细（统一折叠组件） -->
                    <section class="audit-section">
                        <div class="audit-section-title">Cost</div>
                        <template v-if="audit.usage.cost">
                            <AuditDisclosure
                                v-if="audit.vendorCost"
                                label="vendor"
                                :open="openSections.has('vendorCost')"
                                title="点击展开 vendor 成本分解"
                                @toggle="toggleSection('vendorCost')"
                            >
                                {{ formatCost(audit.usage.cost.total) }}
                                <template #body>
                                    <div class="audit-section-sub">vendor 分解 · vendor token × 入库计价快照</div>
                                    <div class="audit-row"><span class="audit-key">input missed</span><span class="audit-val">{{ formatCost(audit.vendorCost.inputMissedUsd) }} <span class="audit-note-inline">{{ formatTokens(audit.vendorCost.inputMissedTokens) }} tok</span></span></div>
                                    <div class="audit-row"><span class="audit-key">input cached</span><span class="audit-val">{{ formatCost(audit.vendorCost.inputCachedUsd) }} <span class="audit-note-inline">{{ formatTokens(audit.vendorCost.inputCachedTokens) }} tok</span></span></div>
                                    <div class="audit-row"><span class="audit-key">reasoning</span><span class="audit-val">{{ formatCost(audit.vendorCost.reasoningUsd) }} <span class="audit-note-inline">{{ formatTokens(audit.vendorCost.reasoningTokens) }} tok</span></span></div>
                                    <div class="audit-row"><span class="audit-key">tool-call args</span><span class="audit-val">{{ formatCost(audit.vendorCost.toolCallArgsUsd) }} <span class="audit-note-inline">{{ formatTokens(audit.vendorCost.toolCallArgsTokens) }} tok</span></span></div>
                                    <div class="audit-row"><span class="audit-key">text</span><span class="audit-val">{{ formatCost(audit.vendorCost.textUsd) }} <span class="audit-note-inline">{{ formatTokens(audit.vendorCost.textTokens) }} tok</span></span></div>
                                    <div class="audit-row">
                                        <span class="audit-key">pricing</span>
                                        <span class="audit-val audit-muted">
                                            in {{ pricingRate(audit.vendorCost.pricing.inputPerMTok) }} · cached {{ pricingRate(audit.vendorCost.pricing.cachedInputPerMTok) }} · out {{ pricingRate(audit.vendorCost.pricing.outputPerMTok) }}
                                            <span v-if="audit.vendorCost.pricing.version" class="audit-note-inline">{{ audit.vendorCost.pricing.version }}</span>
                                        </span>
                                    </div>
                                </template>
                            </AuditDisclosure>
                            <div v-else class="audit-row"><span class="audit-key">vendor</span><span class="audit-val">{{ formatCost(audit.usage.cost.total) }}</span></div>

                            <AuditDisclosure
                                v-if="audit.usage.estimatedCost"
                                label="估算"
                                :open="openSections.has('estimatedCost')"
                                title="点击查看估算缓存命中率"
                                @toggle="toggleSection('estimatedCost')"
                            >
                                {{ formatCost(audit.usage.estimatedCost.total) }}
                                <template #body>
                                    <div class="audit-row">
                                        <span class="audit-key">cached ratio</span>
                                        <span class="audit-val">{{ estimateCachedRatioLabel }}</span>
                                    </div>
                                </template>
                            </AuditDisclosure>

                            <div v-if="audit.costDrift" class="audit-row">
                                <span class="audit-key">漂移</span>
                                <span class="audit-val" :class="diffClass(audit.costDrift.usd)">
                                    {{ formatCost(audit.costDrift.usd) }}
                                    <span class="audit-note-inline">{{ formatRate(audit.costDrift.rate) }}</span>
                                </span>
                            </div>
                        </template>
                        <div v-else class="audit-muted">未计价</div>
                    </section>

                    <!-- Timing -->
                    <section class="audit-section">
                        <div class="audit-section-title">Timing</div>
                        <div v-if="audit.startedAt" class="audit-row"><span class="audit-key">开始</span><span class="audit-val">{{ fmtPrecise(audit.startedAt) }}</span></div>
                        <div v-if="audit.endedAt" class="audit-row"><span class="audit-key">结束</span><span class="audit-val">{{ fmtPrecise(audit.endedAt) }}</span></div>
                        <template v-if="audit.usage.timing">
                            <div class="audit-row"><span class="audit-key">TTFT</span><span class="audit-val">{{ formatDuration(audit.usage.timing.ttftMs) }}</span></div>
                            <div class="audit-row"><span class="audit-key">Total</span><span class="audit-val">{{ formatDuration(audit.usage.timing.totalMs) }}</span></div>
                            <div class="audit-row"><span class="audit-key">速率</span><span class="audit-val">{{ toFixed1(audit.usage.timing.tokensPerSecond) }} tok/s</span></div>
                        </template>
                        <div v-if="!audit.startedAt && !audit.usage.timing" class="audit-muted">暂无耗时</div>
                    </section>

                    </template>

                    <!-- 任务状态（会话汇总：每个 Task 的当前状态） -->
                    <section v-if="audit.tasks.length" class="audit-section audit-span">
                        <div class="audit-section-title">任务状态（{{ audit.tasks.length }}）</div>
                        <div v-for="task in audit.tasks" :key="task.taskId" class="audit-task-row">
                            <span class="audit-step-loc">R#{{ task.runIndex }}·T#{{ task.taskIndex }}</span>
                            <span class="audit-task-title">{{ task.title || 'Task' }}</span>
                            <span class="audit-status" :class="statusClass(task.status)">{{ task.status }}</span>
                            <span class="audit-task-steps">{{ task.stepCount }} steps</span>
                        </div>
                    </section>

                </div>
            </div>
            <div v-else-if="activeTab === 'iterations'" class="drawer-body audit-body iterations-body">
                <!-- 分段：思维链 / 迭代记录 / 系统 -->
                <section class="audit-section">
                    <div class="iter-filters">
                        <button
                            v-for="s in ITERATION_SECTIONS"
                            :key="s.key"
                            class="trace-chip"
                            :class="{ on: iterationSection === s.key }"
                            @click="iterationSection = s.key"
                        >{{ s.label }}</button>
                        <span class="trace-toolbar-gap"></span>
                        <button class="trace-chip" @click="loadIterations()">刷新</button>
                    </div>
                    <div class="iter-summary">
                        <span>{{ iterationBoard.counts.tocs }} 思维链</span>
                        <span>{{ iterationBoard.counts.analyses }} 报告</span>
                        <span>{{ iterationBoard.counts.records }} 迭代记录</span>
                    </div>
                </section>

                <div v-if="iterationSection === 'toc'" class="iter-split" :class="{ split: maximized }">
                    <!-- 列表（窄栏进详情后隐藏） -->
                    <section v-if="maximized || !selectedToc" class="audit-section iter-list">
                        <div class="audit-section-title">
                            <span>思维链</span>
                            <span class="audit-pct">{{ visibleTocs.length }} / {{ iterationBoard.counts.tocs }}</span>
                        </div>
                        <input v-model="tocQuery" class="iter-search" placeholder="搜索输入 / 思维链 / task…" />
                        <div class="iter-filters">
                            <button
                                v-for="f in TOC_STATUS_FILTERS"
                                :key="f.key"
                                class="trace-chip"
                                :class="{ on: tocStatusFilter === f.key }"
                                @click="tocStatusFilter = f.key"
                            >{{ f.label }}</button>
                        </div>
                        <div v-if="!visibleTocs.length" class="audit-muted">
                            {{ iterationsLoading ? 'Loading…' : '暂无思维链 —— 在 Trace 面板选中 Task → ⋯ → Analyze' }}
                        </div>
                        <button
                            v-for="row in visibleTocs"
                            :key="row.tocId"
                            class="iter-toc-row"
                            :class="{ selected: row.tocId === selectedTocId }"
                            @click="openToc(row.tocId)"
                        >
                            <span class="iter-toc-row-title">{{ row.title }}</span>
                            <span class="audit-status" :class="statusClass(row.status)">{{ TOC_STATUS_LABELS[row.status] }}</span>
                            <span v-if="row.adopted" class="iter-badge-adopted">已采纳</span>
                            <span class="iter-toc-row-meta">{{ row.analyses.length }} 报告 · {{ fmtPrecise(row.createdAt) }}</span>
                        </button>
                    </section>

                    <!-- 详情：思维链原文 + 分析报告 -->
                    <section v-if="selectedToc" class="audit-section iter-detail">
                        <div class="iter-detail-head">
                            <button v-if="!maximized" class="trace-chip" @click="backToTocList()">← 列表</button>
                            <span class="iter-detail-id">TOC {{ selectedToc.shortId }}</span>
                            <span class="iter-detail-meta">{{ selectedToc.modelLabel }} · {{ fmtPrecise(selectedToc.createdAt) }}</span>
                            <span class="trace-toolbar-gap"></span>
                            <button class="trace-chip" @click="copyTocChain(selectedToc)">Copy</button>
                            <button class="trace-chip" @click="reanalyzeToc(selectedToc)">再分析</button>
                        </div>
                        <div class="iter-subhead">
                            <span class="iter-label">思维链原文</span>
                            <button class="iter-link" @click="toggleTocText(selectedToc.tocId)">
                                {{ openTocText.has(selectedToc.tocId) ? '收起' : '展开全文' }}
                            </button>
                        </div>
                        <pre
                            class="iter-toc-text"
                            :class="{ expanded: openTocText.has(selectedToc.tocId) }"
                        >{{ selectedTocRecord ? selectedTocRecord.text : '' }}</pre>

                        <div class="iter-subhead iter-subhead-reports">
                            <span class="iter-label">分析报告</span>
                            <span class="audit-pct">{{ selectedToc.analyses.length }}</span>
                        </div>
                        <div v-if="!selectedToc.analyses.length" class="audit-muted">还没有分析报告 —— 点上方「再分析」。</div>
                        <article v-for="row in selectedToc.analyses" :key="row.analysis.analyzeId" class="iter-report">
                            <header class="iter-report-head">
                                <span class="iter-status" :class="row.analysis.status">{{ row.analysis.status }}</span>
                                <span class="iter-report-meta">
                                    {{ row.analysis.model ? row.analysis.model.modelId : 'default' }} · {{ fmtPrecise(row.analysis.createdAt) }}<template v-if="row.durationMs != null"> · {{ formatDuration(row.durationMs) }}</template>
                                </span>
                                <span class="trace-toolbar-gap"></span>
                                <button
                                    v-if="!row.record"
                                    class="trace-chip on"
                                    :disabled="busyAnalyzeId === row.analysis.analyzeId"
                                    @click="adoptAnalysis(selectedToc, row)"
                                >采纳为迭代项</button>
                                <button v-else class="trace-chip" @click="jumpToRecord(row.record.iterationId)">已采纳 · 查看</button>
                                <button v-if="row.analysis.output" class="trace-chip" @click="copyReport(row.analysis.output)">复制</button>
                            </header>
                            <div v-if="row.analysis.userInput" class="iter-input">诉求：{{ row.analysis.userInput }}</div>
                            <div v-if="row.analysis.output" class="iter-report-body markdown-body" v-html="renderMarkdown(row.analysis.output)"></div>
                            <div v-if="row.analysis.error" class="iter-error">{{ row.analysis.error }}</div>
                            <div v-if="!row.analysis.output && !row.analysis.error" class="audit-muted">
                                {{ row.analysis.status === 'running' || row.analysis.status === 'pending' ? '分析中…' : '（无输出）' }}
                            </div>
                            <div v-if="row.analysis.feedback.length" class="iter-feedback-list">
                                <div v-for="f in row.analysis.feedback" :key="f.feedbackId" class="iter-feedback">
                                    <span class="iter-feedback-meta">{{ fmtPrecise(f.createdAt) }}</span>
                                    <span>{{ f.content }}</span>
                                </div>
                            </div>
                            <div class="iter-feedback-form">
                                <input
                                    :value="feedbackDraft(row.analysis.analyzeId)"
                                    placeholder="对这次分析的反馈…"
                                    @input="setFeedbackDraft(row.analysis.analyzeId, $event.target.value)"
                                    @keydown.enter="submitFeedback(row.analysis.analyzeId)"
                                />
                                <button @click="submitFeedback(row.analysis.analyzeId)">Send</button>
                            </div>
                        </article>
                    </section>

                    <div v-else-if="maximized" class="audit-muted iter-detail-empty">从左侧选择一条思维链查看分析报告</div>
                </div>

                <!-- 迭代记录：分析报告的采纳闭环 -->
                <section v-else-if="iterationSection === 'records'" class="audit-section">
                    <div class="audit-section-title">
                        <span>迭代记录</span>
                        <span class="audit-pct">{{ visibleRecords.length }} / {{ iterationBoard.counts.records }}</span>
                    </div>
                    <div class="iter-filters">
                        <button
                            v-for="f in RECORD_STATUS_FILTERS"
                            :key="f.key"
                            class="trace-chip"
                            :class="{ on: recordStatusFilter === f.key }"
                            @click="recordStatusFilter = f.key"
                        >{{ f.label }}<template v-if="f.key !== 'all'"> {{ iterationBoard.counts.byStatus[f.key] }}</template></button>
                    </div>
                    <div v-if="!visibleRecords.length" class="audit-muted">
                        {{ iterationsLoading ? 'Loading…' : '还没有迭代记录 —— 在分析报告上点「采纳为迭代项」' }}
                    </div>
                    <div v-for="row in visibleRecords" :key="row.record.iterationId" class="iter-record">
                        <button class="iter-record-head" @click="toggleRecord(row.record.iterationId)">
                            <span class="trace-head-caret">{{ openRecordId === row.record.iterationId ? '−' : '+' }}</span>
                            <span class="iter-record-title">{{ row.record.title }}</span>
                            <span class="audit-status" :class="iterationStatusTone(row.record.status)">{{ ITERATION_STATUS_LABELS[row.record.status] }}</span>
                            <span class="iter-record-versions">{{ versionLabel(row.record.base) }} → {{ row.record.applied ? versionLabel(row.record.applied) : '—' }}</span>
                        </button>
                        <div v-if="openRecordId === row.record.iterationId" class="iter-record-body">
                            <div class="iter-record-source">
                                <button v-if="row.sourceLabel" class="iter-link" @click="selectTocFromRecord(row)">{{ row.sourceLabel }}</button>
                                <span v-else class="audit-muted">手工创建</span>
                                <span class="iter-record-updated">更新 {{ fmtPrecise(row.record.updatedAt) }}</span>
                            </div>
                            <div v-if="row.record.intent" class="iter-record-intent">{{ row.record.intent }}</div>
                            <div class="audit-row"><span class="audit-key">基线版本</span><span class="audit-val audit-mono">{{ versionDetail(row.record.base) || versionLabel(row.record.base) }}</span></div>
                            <div v-if="row.record.applied" class="audit-row"><span class="audit-key">应用版本</span><span class="audit-val audit-mono">{{ versionDetail(row.record.applied) || versionLabel(row.record.applied) }}</span></div>
                            <textarea
                                class="iter-notes"
                                rows="3"
                                placeholder="复盘备注：改了什么 / 为什么回滚…"
                                :value="recordDraft(row.record.iterationId, row.record.notes)"
                                @input="setRecordDraft(row.record.iterationId, $event.target.value)"
                            ></textarea>
                            <div class="iter-record-actions">
                                <button class="trace-chip" @click="saveRecordNotes(row.record)">保存备注</button>
                                <button
                                    v-for="act in iterationActions(row.record.status)"
                                    :key="act.action"
                                    class="trace-chip"
                                    :class="{ on: act.tone === 'primary', danger: act.tone === 'danger' }"
                                    @click="runIterationAction(row.record, act)"
                                >{{ act.label }}</button>
                            </div>
                        </div>
                    </div>
                </section>

                <!-- 系统版本与构建 -->
                <section v-else class="audit-section">
                    <div class="audit-section-title">
                        <span>系统版本与构建</span>
                        <span v-if="systemVersion" class="audit-pct">{{ fmtPrecise(systemVersion.readAt) }}</span>
                    </div>
                    <template v-if="systemVersion">
                        <div class="sys-version-hero">
                            <span class="sys-version-value">{{ versionLabel(systemVersion) }}</span>
                            <span v-if="systemVersion.dirty" class="sys-dirty">dirty</span>
                        </div>
                        <div class="audit-row"><span class="audit-key">describe</span><span class="audit-val audit-mono">{{ systemVersion.version || '—' }}</span></div>
                        <div class="audit-row"><span class="audit-key">提交</span><span class="audit-val audit-mono">{{ systemVersion.commit || '—' }}</span></div>
                        <div class="audit-row"><span class="audit-key">分支</span><span class="audit-val audit-mono">{{ systemVersion.branch || '—' }}</span></div>
                        <div class="audit-row"><span class="audit-key">提交说明</span><span class="audit-val">{{ systemVersion.commitSubject || '—' }}</span></div>
                        <div class="audit-row"><span class="audit-key">提交时间</span><span class="audit-val audit-mono">{{ systemVersion.commitDate || '—' }}</span></div>
                        <div class="audit-row"><span class="audit-key">包版本</span><span class="audit-val audit-mono">{{ systemVersion.packageVersion || '—' }}</span></div>
                        <div class="audit-row"><span class="audit-key">Node</span><span class="audit-val audit-mono">{{ systemVersion.node || '—' }}</span></div>
                        <div class="audit-row"><span class="audit-key">平台</span><span class="audit-val audit-mono">{{ systemVersion.platform || '—' }}</span></div>
                        <div v-if="!systemVersion.commit" class="audit-note">未检测到 git，仅显示包版本。</div>
                    </template>
                    <div v-else class="audit-muted">{{ iterationsLoading ? 'Loading…' : '暂无系统信息' }}</div>
                </section>
            </div>
            <StoragePanel v-else-if="activeTab === 'storage'" />
            <div v-else class="drawer-body">
                <div class="drawer-tabs sub">
                    <select v-model="failureKind" title="失败类别">
                        <option v-for="kind in FAILURE_KINDS" :key="kind" :value="kind">
                            {{ kind === 'all' ? '全部类别' : kind }}
                        </option>
                    </select>
                    <button class="ev-toggle" @click="loadFailures">刷新</button>
                    <span class="log-count">{{ failureRows.length }} 条</span>
                </div>
                <div v-if="failuresError" class="empty-hint">{{ failuresError }}</div>
                <div v-else-if="failuresLoading" class="empty-hint">加载中…</div>
                <div v-else class="event-log">
                    <div
                        v-for="row in failureRows"
                        :key="row.failureId"
                        class="event-row log-row"
                        @mouseenter="showLogTip($event, row.summary || '-')"
                        @mousemove="showLogTip($event, row.summary || '-')"
                        @mouseleave="hideLogTip"
                    >
                        <span class="ev-dot ev-approval"></span>
                        <span class="event-time">{{ fmtClock(row.createdAt) }}</span>
                        <span class="event-type ev-approval">{{ row.kind }}</span>
                        <span class="event-module">{{ short(row.sessionId, 8) }}</span>
                        <span class="event-summary">{{ row.summary || '-' }}</span>
                    </div>
                    <div v-if="!failureRows.length" class="empty-hint">暂无失败记录</div>
                </div>
            </div>
            <!-- 日志 hover 弹窗：宽度不足时显示完整内容 -->
            <div
                v-if="logTip"
                class="log-tooltip"
                :style="{ left: logTip.x + 12 + 'px', top: logTip.y + 12 + 'px' }"
            >{{ logTip.text }}</div>

            <!-- Analyze 弹窗：记录 user input + 可选模型，冻结/复用 TOC 后跑独立分析 -->
            <div v-if="analyzeOpen" class="toc-modal-backdrop" @click.self="closeAnalyze">
                <div class="toc-modal">
                    <div class="toc-modal-title">Analyze thinking chain</div>
                    <label class="toc-modal-label">Instructions</label>
                    <textarea
                        v-model="analyzeInput"
                        rows="4"
                        placeholder="Audit this thinking chain for defects and propose fixes…"
                    ></textarea>
                    <label class="toc-modal-label">Model (optional)</label>
                    <input v-model="analyzeModel" placeholder="default" />
                    <div class="toc-modal-actions">
                        <button @click="closeAnalyze">Cancel</button>
                        <button class="primary" :disabled="analyzeBusy" @click="runAnalyze">
                            {{ analyzeBusy ? 'Analyzing…' : 'Analyze' }}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </aside>
</template>

<style scoped>
.right-panel {
    flex: 0 0 0;
    width: 0;
    min-width: 0;
    height: 100%;
    overflow: hidden;
    background: var(--bg);
    border-left: 0 solid var(--border);
    transition: width 0.16s ease;
    position: relative;
}
.right-panel.open {
    width: 440px;
    flex-basis: 440px;
    border-left-width: 1px;
}
.right-panel.maximized {
    flex: 1 1 auto;
    width: auto !important;
    min-width: 0 !important;
    position: static;
    border-left: 1px solid var(--border);
}
/*
 * 最大化 = 内容适配，而不是把窄栏拉满：居中限宽 + 宽屏双栏。
 */
.right-panel.maximized .drawer-body {
    width: min(100%, 1280px);
    margin: 0 auto;
    padding-left: 24px;
    padding-right: 24px;
}
/*
 * 最大化 ≥1180px：Trace 看板 = 左 trace 列表 + 右 span 明细；
 * 概览（scope 标题 + KPI）跨整行。窄栏下退回上下堆叠。
 */
@media (min-width: 1180px) {
    .right-panel.maximized .trace-body {
        display: grid;
        grid-template-columns: minmax(0, 6fr) minmax(0, 5fr);
        column-gap: 28px;
        align-content: start;
    }
    .right-panel.maximized .trace-body > .audit-head,
    .right-panel.maximized .trace-body > .trace-kpi {
        grid-column: 1 / -1;
    }
    .right-panel.maximized .trace-body > .trace-list {
        grid-column: 1;
        grid-row: 3;
    }
    .right-panel.maximized .trace-body > .trace-detail {
        grid-column: 2;
        grid-row: 3;
    }
    .right-panel.maximized .trace-kpi {
        grid-template-columns: repeat(5, minmax(0, 1fr));
    }
}
.right-panel-handle {
    position: absolute;
    top: 50%;
    left: -7px;
    transform: translateY(-50%);
    width: 14px;
    height: 36px;
    border: 1px solid var(--border);
    border-right: none;
    border-radius: 6px 0 0 6px;
    background: var(--bg-panel);
    color: var(--fg-tertiary);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10;
    padding: 0;
}
.right-panel-handle:hover {
    background: var(--bg-hover);
    color: var(--fg);
}
.right-panel-inner {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
}
.drawer-head {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border-soft);
}
.drawer-tabs {
    display: flex;
    gap: 4px;
}
.drawer-tabs button {
    padding: 4px 10px;
    border: none;
    background: transparent;
    color: var(--fg-secondary);
    font-size: 13px;
    border-radius: 6px;
    cursor: pointer;
}
.drawer-tabs button.on {
    background: var(--bg-active);
    color: var(--fg);
    font-weight: 500;
}
.drawer-head-actions {
    display: flex;
    gap: 4px;
}
.icon-btn {
    width: 28px;
    height: 28px;
    border: none;
    background: transparent;
    color: var(--fg-secondary);
    border-radius: 6px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
}
.icon-btn:hover {
    background: var(--bg-hover);
    color: var(--fg);
}
.drawer-body {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    min-height: 0;
}
.drawer-tabs.sub {
    margin-bottom: 12px;
    align-items: center;
}
.drawer-tabs.sub select {
    padding: 4px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-panel);
    color: var(--fg);
    font-size: 12px;
}
.ev-toggle {
    padding: 4px 10px;
    border: 1px solid var(--border);
    background: var(--bg-panel);
    color: var(--fg-secondary);
    font-size: 12px;
    border-radius: 6px;
    cursor: pointer;
}
.ev-toggle.on {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: var(--accent);
}
.empty-hint {
    color: var(--fg-tertiary);
    font-size: 13px;
    padding: 20px 0;
    text-align: center;
}
.exec-log {
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.log-result {
    padding: 10px 12px;
    border-radius: 8px;
    font-size: 13px;
}
.log-result.ok {
    background: rgba(34, 197, 94, 0.1);
    border: 1px solid rgba(34, 197, 94, 0.3);
}
.log-result.fail {
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.3);
}
.log-line {
    display: flex;
    gap: 8px;
    margin-bottom: 4px;
}
.log-tag {
    font-weight: 600;
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
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 12px;
    color: var(--fg-secondary);
    padding: 4px 0;
}
/* Secondary part of the log header, e.g. the aggregated step duration. */
.log-head-total {
    text-transform: none;
    font-size: 10px;
    color: var(--fg-tertiary);
    font-weight: 500;
}
.kanban-card {
    border: 1px solid var(--border-soft);
    border-radius: 8px;
    padding: 8px 10px;
    margin-bottom: 6px;
    background: var(--bg-panel);
}
.kanban-head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    margin-bottom: 4px;
}
.kanban-kind {
    font-weight: 600;
    text-transform: uppercase;
}
.kanban-status {
    padding: 1px 6px;
    border-radius: 8px;
    font-size: 10px;
}
.kanban-time, .kanban-duration {
    color: var(--fg-tertiary);
    font-family: ui-monospace, monospace;
}
.kanban-tool {
    font-size: 12px;
    color: var(--accent);
    margin-bottom: 2px;
}
.kanban-content {
    font-size: 12px;
    color: var(--fg-secondary);
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
    max-height: 120px;
    overflow-y: auto;
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
    font-size: 11px;
}
.usage-label {
    color: var(--fg-tertiary);
    min-width: 50px;
}
.usage-value {
    font-weight: 600;
    font-family: ui-monospace, monospace;
}
.usage-breakdown {
    color: var(--fg-secondary);
    font-family: ui-monospace, monospace;
}
.event-log {
    display: flex;
    flex-direction: column;
    gap: 2px;
}
.event-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 6px;
    border-radius: 4px;
    font-size: 12px;
}
.ev-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
}
.ev-dot.ev-goal { background: #8b5cf6; }
.ev-dot.ev-task { background: #3b82f6; }
.ev-dot.ev-step { background: #10b981; }
.ev-dot.ev-other { background: var(--fg-tertiary); }
.ev-dot.ev-error { background: #ef4444; }
.ev-dot.ev-warn { background: #f59e0b; }
.ev-dot.ev-info { background: #10b981; }
.ev-dot.ev-debug { background: var(--fg-tertiary); }
.event-type.ev-error { color: #ef4444; }
.event-type.ev-warn { color: #f59e0b; }
.event-type.ev-info { color: #10b981; }
.event-type.ev-debug { color: var(--fg-tertiary); }
.event-module {
    font-family: ui-monospace, monospace;
    font-size: 11px;
    color: var(--fg-tertiary);
    flex-shrink: 0;
}
/* 日志行：固定各列宽度，避免 level / 时间 / 模块相互重叠；内容省略靠 hover 弹窗看全 */
.log-row .event-time {
    width: 66px;
}
.log-row .event-type {
    width: 44px;
    min-width: 44px;
    text-transform: uppercase;
    font-size: 11px;
}
.log-row .event-module {
    width: 84px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.log-tooltip {
    position: fixed;
    z-index: 200;
    max-width: min(560px, 70vw);
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-elevated, var(--bg-panel));
    color: var(--fg);
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    pointer-events: none;
    box-shadow: var(--shadow-md, 0 6px 18px rgba(0, 0, 0, 0.18));
}
.log-count {
    margin-left: auto;
    font-size: 11px;
    color: var(--fg-tertiary);
}
.event-time {
    color: var(--fg-tertiary);
    font-family: ui-monospace, monospace;
    flex-shrink: 0;
}
.event-type {
    font-weight: 500;
    min-width: 80px;
    flex-shrink: 0;
}
.event-summary {
    color: var(--fg-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
}

/* ---------- Audit panel (docs/web/观测看板设计.md) ---------- */
.audit-body {
    display: flex;
    flex-direction: column;
    gap: 12px;
}
/* ---------- Trace 看板（「审计」+「Context」合并，docs/web/观测看板设计.md v3） ---------- */
/* 窄栏 3 列（2 行），最大化时限宽后 5 列一行。 */
.trace-kpi {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px;
}
.trace-kpi-card {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
}
.trace-kpi-label {
    font-size: 10px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--fg-tertiary);
}
.trace-kpi-value {
    font-size: 14px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--fg);
}
.trace-kpi-sub {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 10px;
    color: var(--fg-tertiary);
}
.trace-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    margin: 2px 0 6px;
}
.trace-toolbar-gap {
    flex: 1;
}
.trace-chip {
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--bg);
    color: var(--fg-secondary);
    font-size: 11px;
    cursor: pointer;
}
.trace-chip:hover {
    background: var(--bg-hover);
}
.trace-chip.on {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent-text);
}
.trace-groups {
    display: flex;
    flex-direction: column;
}
/* Run 头（第一级，可折叠）：run 序号 + 用户输入摘要 + 步数/耗时 */
.trace-run-head {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 5px 4px;
    border: none;
    border-top: 1px solid var(--border-soft);
    background: transparent;
    text-align: left;
    font-size: 11px;
    cursor: pointer;
}
.trace-run-head:first-child {
    border-top: none;
}
.trace-run-head:hover {
    background: var(--bg-hover);
}
.trace-run-loc {
    flex-shrink: 0;
    padding: 0 4px;
    border-radius: 3px;
    background: var(--accent-soft);
    color: var(--accent-text);
    font-family: ui-monospace, monospace;
    font-size: 10px;
    font-weight: 700;
}
.trace-run-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
    color: var(--fg);
}
/* Task 头（第二级，可折叠）：R#/T# + 任务标题 + 状态 + 步数/耗时 */
.trace-task-head {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 4px 4px 4px 20px;
    border: none;
    background: transparent;
    text-align: left;
    font-size: 11px;
    cursor: pointer;
}
.trace-task-head:hover {
    background: var(--bg-hover);
}
.trace-task-loc {
    flex-shrink: 0;
    font-family: ui-monospace, monospace;
    font-size: 10px;
    color: var(--fg-tertiary);
}
.trace-task-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
    color: var(--fg);
}
/* Run / Task 头共用：折叠标识与右侧聚合信息 */
.trace-head-caret {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 12px;
    height: 12px;
    flex-shrink: 0;
    font-weight: 700;
    line-height: 1;
    color: var(--fg-tertiary);
}
.trace-head-meta {
    flex-shrink: 0;
    font-family: ui-monospace, monospace;
    font-size: 10px;
    color: var(--fg-tertiary);
}
.trace-span {
    display: grid;
    grid-template-columns: 14px 66px 46px minmax(0, 1fr) 46px 40px;
    align-items: center;
    gap: 5px;
    padding: 3px 4px 3px 34px;
    border-radius: 4px;
    font-size: 11px;
    cursor: pointer;
}
.trace-span:hover {
    background: var(--bg-hover);
}
.trace-span.selected {
    background: var(--accent-soft);
    box-shadow: inset 2px 0 0 var(--accent);
}
/* 工具子 span：缩进 + 竖向引导线，保持「模型步 → 工具调用」的树形可读性。 */
.trace-span.child {
    position: relative;
    padding-left: 48px;
}
.trace-span.child::before {
    content: '';
    position: absolute;
    top: 2px;
    bottom: 2px;
    left: 40px;
    width: 1px;
    background: var(--border);
}
.trace-caret {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    border-radius: 3px;
    font-weight: 700;
    line-height: 1;
    color: var(--fg-tertiary);
    opacity: 0;
    transition: opacity 0.1s ease;
}
.trace-span:hover .trace-caret,
.trace-caret.open {
    opacity: 1;
}
.trace-caret.open {
    color: var(--fg-secondary);
}
.trace-loc {
    font-family: ui-monospace, monospace;
    font-size: 10px;
    color: var(--fg-tertiary);
    white-space: nowrap;
}
.trace-kind {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--thinking);
}
.trace-kind.tool {
    color: var(--tool);
}
.trace-span.error .trace-kind {
    color: var(--error);
}
.trace-bar {
    position: relative;
    height: 12px;
    border-radius: 3px;
    background: var(--bg-code);
    overflow: hidden;
}
.trace-bar-fill {
    position: absolute;
    top: 0;
    bottom: 0;
    border-radius: 3px;
    background: var(--thinking);
}
.trace-span.tool .trace-bar-fill {
    background: var(--tool);
}
.trace-span.error .trace-bar-fill {
    background: var(--error);
}
.trace-bar .ctx-bar-fill {
    position: absolute;
    top: 0;
    left: 0;
    height: 100%;
}
.trace-tokens,
.trace-delta {
    font-family: ui-monospace, monospace;
    font-size: 10px;
    text-align: right;
    white-space: nowrap;
}
.trace-tokens {
    color: var(--fg-secondary);
}
.trace-delta.up { color: var(--ok); }
.trace-delta.down { color: var(--warn); }
.trace-delta.flat { color: var(--fg-tertiary); }
.trace-item .ctx-diff {
    padding-left: 22px;
}
.trace-detail {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
}
.audit-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
    border-bottom: 1px solid var(--border-soft);
    padding-bottom: 8px;
}
.audit-head-main {
    flex: 1;
    min-width: 0;
}
/* 步骤/任务的执行开始时间：面板右上角常驻，不只放在 Timing 区块。 */
.audit-head-start {
    flex-shrink: 0;
    padding-top: 1px;
    font-size: 11px;
    color: var(--fg-tertiary);
    font-family: ui-monospace, monospace;
    white-space: nowrap;
}
.audit-info-btn {
    display: inline-grid;
    place-items: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--fg-tertiary);
    cursor: pointer;
    flex-shrink: 0;
}
.audit-info-btn:hover,
.audit-info-btn.on {
    background: var(--bg-hover);
    color: var(--accent);
}

.audit-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--fg);
    word-break: break-word;
}
.audit-subtitle {
    margin-top: 2px;
    font-size: 11px;
    color: var(--fg-tertiary);
    font-family: ui-monospace, monospace;
}
.audit-section {
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
    padding: 8px 10px;
    background: var(--bg-panel);
}
.audit-section-title {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    color: var(--fg-tertiary);
    margin-bottom: 6px;
}
.audit-title-meta {
    text-transform: none;
    letter-spacing: 0;
    font-weight: 500;
    font-size: 11px;
    color: var(--fg-secondary);
}
.audit-pct {
    text-transform: none;
    font-weight: 500;
    color: var(--accent-text);
    font-family: ui-monospace, monospace;
}
.audit-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    font-size: 12px;
    margin: 3px 0;
}
.audit-key {
    color: var(--fg-tertiary);
    flex-shrink: 0;
}
.audit-val {
    color: var(--fg);
    font-family: ui-monospace, monospace;
    text-align: right;
    word-break: break-word;
}
.audit-strong {
    font-weight: 600;
}
.audit-muted {
    color: var(--fg-tertiary);
    font-size: 12px;
}
.audit-mono {
    font-family: ui-monospace, monospace;
    font-size: 11px;
    color: var(--fg);
}
.audit-tool-block {
    margin: 6px 0;
}
.audit-tool-output {
    max-height: 360px;
}
.audit-warn {
    color: var(--warn);
}
.audit-note {
    margin-top: 6px;
    font-size: 11px;
    color: var(--fg-secondary);
}
.audit-diff.up { color: var(--ok); }
.audit-diff.down { color: var(--warn); }
.audit-diff.flat { color: var(--fg-tertiary); }

/* Context fill bar + stacked segments */
.context-bar {
    height: 6px;
    border-radius: 3px;
    background: var(--bg-code);
    overflow: hidden;
    margin-bottom: 6px;
}
.context-bar-fill {
    height: 100%;
    background: var(--accent);
}
.seg-stack {
    display: flex;
    height: 8px;
    border-radius: 4px;
    overflow: hidden;
    background: var(--bg-code);
    margin-bottom: 6px;
}
.seg {
    display: block;
    height: 100%;
    min-width: 0;
}
.seg-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    margin: 2px 0;
}
.seg-dot {
    width: 8px;
    height: 8px;
    border-radius: 2px;
    flex-shrink: 0;
}
.seg-label {
    flex: 1;
    color: var(--fg-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.seg-tokens,
.seg-ratio {
    font-family: ui-monospace, monospace;
    color: var(--fg-tertiary);
    flex-shrink: 0;
}
.seg-ratio {
    min-width: 46px;
    text-align: right;
}

/* 位置标签：任务状态与 trace 列表共用 */
.audit-step-loc {
    font-family: ui-monospace, monospace;
    font-weight: 700;
    color: var(--fg-tertiary);
    background: var(--bg-code);
    border-radius: 3px;
    padding: 0 4px;
    flex-shrink: 0;
    white-space: nowrap;
}
/* Task/Step 状态徽标（审计面板） */
.audit-status {
    display: inline-flex;
    align-items: center;
    margin-left: 6px;
    padding: 0 6px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 600;
    line-height: 16px;
    background: var(--bg-hover);
    color: var(--fg-secondary);
    vertical-align: middle;
}
.audit-status.task {
    font-weight: 500;
    opacity: 0.9;
}
.audit-status.ok {
    background: rgba(34, 197, 94, 0.12);
    color: var(--ok);
}
.audit-status.bad {
    background: rgba(239, 68, 68, 0.12);
    color: #ef4444;
}
.audit-status.warn {
    background: rgba(245, 158, 11, 0.14);
    color: #f59e0b;
}
.audit-status.run {
    background: var(--accent-soft);
    color: var(--accent);
}
.audit-task-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
    font-size: 11px;
    color: var(--fg-secondary);
    border-radius: 4px;
}
.audit-task-row:hover {
    background: var(--bg-hover);
}
.audit-task-title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg);
}
.audit-task-steps {
    flex-shrink: 0;
    color: var(--fg-tertiary);
    font-family: ui-monospace, monospace;
}
.audit-text {
    margin: 0;
    max-height: 260px;
    overflow: auto;
    font-family: ui-monospace, monospace;
    font-size: 12px;
    line-height: 1.5;
    color: var(--fg-secondary);
    white-space: pre-wrap;
    word-break: break-word;
}
/* Donut (SVG arcs) for input breakdown — hover 突出 + 气泡 */
.donut-wrap {
    position: relative;
    display: flex;
    justify-content: center;
    margin-bottom: 8px;
}
.donut-svg {
    width: 108px;
    height: 108px;
    overflow: visible;
}
.donut-arc {
    fill: var(--arc-color);
    cursor: pointer;
    transition: transform 0.12s ease, opacity 0.12s ease;
    transform-origin: 50px 50px;
}
.donut-arc.dim {
    opacity: 0.4;
}
.donut-hole {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 72px;
    height: 72px;
    border-radius: 50%;
    background: var(--bg-panel);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1px;
    pointer-events: none;
}
.donut-tip {
    position: absolute;
    z-index: 6;
    pointer-events: none;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-elevated);
    box-shadow: var(--shadow-md);
    color: var(--fg);
    font-size: 11px;
    white-space: nowrap;
}
.donut-tip-title {
    display: flex;
    align-items: center;
    gap: 5px;
    font-weight: 600;
    margin-bottom: 3px;
}
.donut-tip-row {
    font-family: ui-monospace, monospace;
    color: var(--fg-secondary);
}
.donut-num {
    font-size: 14px;
    font-weight: 600;
    font-family: ui-monospace, monospace;
    color: var(--fg);
}
.donut-cap {
    font-size: 10px;
    color: var(--fg-tertiary);
}
.audit-note-inline {
    margin-left: 4px;
    color: var(--fg-tertiary);
    font-size: 11px;
}
.audit-total .audit-key,
.audit-total .audit-val {
    font-weight: 600;
    color: var(--fg);
}
/* Clickable segment rows + original-text expansion */
.seg-row {
    width: 100%;
    border: none;
    background: transparent;
    cursor: pointer;
    text-align: left;
    padding: 2px 4px;
    border-radius: 4px;
}
.seg-row:hover,
.seg-row.open,
.seg-row.hot {
    background: var(--bg-hover);
}
.seg-caret {
    display: inline-grid;
    place-items: center;
    color: var(--fg-tertiary);
    flex-shrink: 0;
}
/* Context 追踪：分段堆叠增长条 */
.ctx-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin-bottom: 6px;
    font-size: 11px;
    color: var(--fg-secondary);
    font-family: ui-monospace, monospace;
}
.ctx-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 10px;
    color: var(--fg-tertiary);
}
.ctx-legend-item {
    display: inline-flex;
    align-items: center;
    gap: 4px;
}
.ctx-bar-fill {
    display: flex;
    height: 100%;
    border-radius: 3px;
    overflow: hidden;
    transition: width 0.15s ease;
}
.ctx-seg {
    display: block;
    height: 100%;
}
.ctx-diff {
    padding: 2px 0 6px 6px;
}
.ctx-diff-label {
    margin: 4px 0 2px;
    font-size: 11px;
    font-weight: 600;
    color: var(--fg-secondary);
    font-family: ui-monospace, monospace;
}
.audit-section-sub {
    margin: 8px 0 4px;
    font-size: 11px;
    font-weight: 600;
    color: var(--fg-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.4px;
}
.output-bar {
    display: flex;
    height: 8px;
    border-radius: 4px;
    overflow: hidden;
    margin: 4px 0 8px;
    background: var(--border-soft);
}
.output-seg {
    display: block;
    height: 100%;
}
.seg-content {
    margin: 2px 0 6px;
    padding: 8px 10px;
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
    background: var(--bg-code);
    color: var(--fg-secondary);
    font-family: ui-monospace, monospace;
    font-size: 11px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 240px;
    overflow: auto;
}
.diff-toggle {
    margin-top: 4px;
    width: 100%;
    padding: 5px 8px;
    border: 1px dashed var(--border);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--fg-secondary);
    font-size: 11px;
    cursor: pointer;
}
.diff-toggle:hover {
    color: var(--accent);
    border-color: var(--accent);
}

/* ---------- TOC dot menu（步骤明细块右上角） ---------- */
.toc-menu {
    position: relative;
    display: inline-flex;
    margin-left: 6px;
    vertical-align: middle;
}
.toc-menu-trigger {
    display: inline-flex;
    align-items: center;
    border: 0;
    background: transparent;
    color: var(--fg-tertiary);
    padding: 2px;
    border-radius: 3px;
    cursor: pointer;
}
.toc-menu-trigger:hover {
    color: var(--accent);
    background: var(--accent-soft);
}
.toc-menu-trigger.copied {
    color: var(--accent);
}
/* 点击展开、点击项才关闭：不依赖 hover，避免移动鼠标时菜单消失 */
.toc-menu-pop {
    position: absolute;
    right: 0;
    top: 100%;
    margin-top: 4px;
    z-index: 30;
    display: inline-flex;
    gap: 4px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 4px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
}
.toc-menu-pop button {
    border: 0;
    background: transparent;
    color: var(--fg);
    font-size: 11px;
    padding: 3px 8px;
    cursor: pointer;
    border-radius: 3px;
}
.toc-menu-pop button:hover {
    background: var(--accent-soft);
    color: var(--accent);
}

/* ---------- Analyze 弹窗 ---------- */
.toc-modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 60;
}
.toc-modal {
    width: 440px;
    max-width: 90vw;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.toc-modal-title {
    font-weight: 600;
    color: var(--fg);
}
.toc-modal-label {
    font-size: 11px;
    color: var(--fg-tertiary);
}
.toc-modal textarea,
.toc-modal input {
    width: 100%;
    background: var(--bg-code);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 6px 8px;
    font-size: 12px;
    box-sizing: border-box;
}
.toc-modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 6px;
}
.toc-modal-actions button {
    border: 1px solid var(--border);
    background: transparent;
    color: var(--fg);
    border-radius: var(--radius-sm);
    padding: 4px 12px;
    cursor: pointer;
}
.toc-modal-actions button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
}

/* ---------- Iterations 面板（docs/web/迭代面板设计.md v1） ---------- */
.iterations-body {
    padding: 8px 10px;
}
.iter-filters {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    margin: 4px 0;
}
.iter-summary {
    display: flex;
    gap: 12px;
    margin-top: 2px;
    font-size: 10px;
    color: var(--fg-tertiary);
    font-family: ui-monospace, monospace;
}
/* 窄栏：列表 / 详情二选一；最大化：左列表 / 右详情 */
.iter-split {
    display: flex;
    flex-direction: column;
    gap: 12px;
}
.iter-split.split {
    display: grid;
    grid-template-columns: minmax(0, 5fr) minmax(0, 7fr);
    column-gap: 20px;
    align-items: start;
}
.iter-list {
    min-width: 0;
    margin-bottom: 0;
}
.iter-detail {
    min-width: 0;
    margin-bottom: 0;
}
.iter-detail-empty {
    padding: 16px 4px;
}
.iter-search {
    width: 100%;
    box-sizing: border-box;
    background: var(--bg-code);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 4px 8px;
    font-size: 11px;
}
.iter-toc-row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 5px 6px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    text-align: left;
    cursor: pointer;
    font-size: 11px;
}
.iter-toc-row:hover {
    background: var(--bg-hover);
}
.iter-toc-row.selected {
    background: var(--accent-soft);
    box-shadow: inset 2px 0 0 var(--accent);
}
.iter-toc-row-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg);
}
.iter-toc-row-meta {
    flex-shrink: 0;
    font-family: ui-monospace, monospace;
    font-size: 10px;
    color: var(--fg-tertiary);
}
.iter-badge-adopted {
    flex-shrink: 0;
    padding: 0 5px;
    border-radius: 999px;
    background: var(--ok-soft);
    color: var(--ok);
    font-size: 10px;
    font-weight: 600;
    line-height: 16px;
}
.iter-detail-head {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--border-soft);
}
.iter-detail-id {
    font-family: ui-monospace, monospace;
    font-weight: 700;
    font-size: 11px;
    color: var(--fg);
}
.iter-detail-meta {
    font-family: ui-monospace, monospace;
    font-size: 10px;
    color: var(--fg-tertiary);
}
.iter-subhead {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin: 8px 0 4px;
}
.iter-subhead-reports {
    margin-top: 12px;
}
.iter-label {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--fg-tertiary);
}
.iter-link {
    border: none;
    background: transparent;
    padding: 0;
    color: var(--accent);
    font-size: 10px;
    cursor: pointer;
}
.iter-link:hover {
    text-decoration: underline;
}
.iter-input {
    font-size: 11px;
    color: var(--fg-secondary);
    margin: 4px 0;
}
/* 思维链原文：默认定高折叠，展开后完整显示 */
.iter-toc-text {
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 11px;
    line-height: 1.5;
    background: var(--bg-code);
    border-radius: var(--radius-sm);
    padding: 8px;
    max-height: 160px;
    overflow: auto;
    margin: 0;
    color: var(--fg-secondary);
}
.iter-toc-text.expanded {
    max-height: none;
}
/* 分析报告 */
.iter-report {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px 10px;
    margin-bottom: 10px;
    min-width: 0;
}
.iter-report-head {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
}
.iter-report-meta {
    font-family: ui-monospace, monospace;
    font-size: 10px;
    color: var(--fg-tertiary);
}
.iter-status {
    font-size: 10px;
    text-transform: uppercase;
    padding: 1px 5px;
    border-radius: 3px;
    background: var(--bg-code);
    color: var(--fg-tertiary);
}
.iter-status.succeeded {
    color: var(--ok);
}
.iter-status.failed {
    color: var(--error);
}
.iter-status.running,
.iter-status.pending {
    color: var(--accent);
}
.iter-report-body {
    margin-top: 6px;
    font-size: 12px;
    line-height: 1.55;
    color: var(--fg-secondary);
    overflow-wrap: anywhere;
}
.iter-error {
    font-size: 11px;
    color: var(--error);
    margin-top: 4px;
    overflow-wrap: anywhere;
}
.iter-feedback-list {
    margin-top: 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
}
.iter-feedback {
    font-size: 11px;
    color: var(--fg-secondary);
    display: flex;
    gap: 6px;
}
.iter-feedback-meta {
    color: var(--fg-tertiary);
    font-family: ui-monospace, monospace;
    flex-shrink: 0;
}
.iter-feedback-form {
    display: flex;
    gap: 6px;
    margin-top: 6px;
}
.iter-feedback-form input {
    flex: 1;
    min-width: 0;
    background: var(--bg-code);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 4px 6px;
    font-size: 11px;
}
.iter-feedback-form button {
    border: 1px solid var(--border);
    background: transparent;
    color: var(--fg);
    border-radius: var(--radius-sm);
    padding: 2px 8px;
    font-size: 11px;
    cursor: pointer;
}
/* 迭代记录 */
.iter-record {
    border-bottom: 1px solid var(--border-soft);
}
.iter-record-head {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 4px;
    border: none;
    background: transparent;
    text-align: left;
    cursor: pointer;
    font-size: 11px;
}
.iter-record-head:hover {
    background: var(--bg-hover);
}
.iter-record-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg);
    font-weight: 500;
}
.iter-record-versions {
    flex-shrink: 0;
    font-family: ui-monospace, monospace;
    font-size: 10px;
    color: var(--fg-tertiary);
}
.iter-record-body {
    padding: 2px 4px 10px 18px;
}
.iter-record-source {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 4px;
    font-size: 10px;
    color: var(--fg-tertiary);
}
.iter-record-updated {
    font-family: ui-monospace, monospace;
}
.iter-record-intent {
    font-size: 11px;
    color: var(--fg-secondary);
    margin-bottom: 4px;
}
.iter-notes {
    width: 100%;
    box-sizing: border-box;
    margin-top: 6px;
    background: var(--bg-code);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 6px 8px;
    font-size: 11px;
    font-family: inherit;
    resize: vertical;
}
.iter-record-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 6px;
}
.trace-chip:disabled {
    opacity: 0.5;
    cursor: default;
}
.trace-chip.danger {
    border-color: var(--error);
    color: var(--error);
}
/* 系统版本 */
.sys-version-hero {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 0 10px;
}
.sys-version-value {
    font-family: ui-monospace, monospace;
    font-size: 20px;
    font-weight: 700;
    color: var(--fg);
}
.sys-dirty {
    padding: 0 6px;
    border-radius: 999px;
    background: var(--warn-soft);
    color: var(--warn);
    font-size: 10px;
    font-weight: 600;
    line-height: 16px;
}
/* 报告正文的 Markdown 呈现（与 ExecStream 的 markdown-body 同款语义，面板内更紧凑） */
.iter-report-body :deep(h1),
.iter-report-body :deep(h2),
.iter-report-body :deep(h3),
.iter-report-body :deep(h4) {
    margin: 0.9em 0 0.35em;
    line-height: 1.35;
    font-weight: 600;
    color: var(--fg);
}
.iter-report-body :deep(h1) { font-size: 1.25em; }
.iter-report-body :deep(h2) { font-size: 1.15em; }
.iter-report-body :deep(h3) { font-size: 1.05em; }
.iter-report-body :deep(h1:first-child),
.iter-report-body :deep(h2:first-child),
.iter-report-body :deep(p:first-child) {
    margin-top: 0;
}
.iter-report-body :deep(p),
.iter-report-body :deep(ul),
.iter-report-body :deep(ol),
.iter-report-body :deep(blockquote),
.iter-report-body :deep(pre),
.iter-report-body :deep(table) {
    margin: 0.45em 0;
}
.iter-report-body :deep(ul),
.iter-report-body :deep(ol) {
    padding-left: 1.4em;
}
.iter-report-body :deep(li) {
    margin: 0.2em 0;
}
.iter-report-body :deep(code) {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.92em;
    background: var(--bg-code);
    border-radius: 4px;
    padding: 0.15em 0.4em;
    color: var(--fg);
}
.iter-report-body :deep(pre) {
    background: var(--bg-code);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px 10px;
    overflow-x: auto;
    line-height: 1.45;
}
.iter-report-body :deep(pre code) {
    background: transparent;
    padding: 0;
    white-space: pre;
}
.iter-report-body :deep(blockquote) {
    border-left: 3px solid var(--border);
    padding-left: 10px;
    margin-left: 0;
    color: var(--fg-tertiary);
}
.iter-report-body :deep(a) {
    color: var(--accent);
    text-decoration: none;
}
.iter-report-body :deep(a:hover) {
    text-decoration: underline;
}
.iter-report-body :deep(table) {
    border-collapse: collapse;
    font-size: 11px;
    display: block;
    overflow-x: auto;
}
.iter-report-body :deep(th),
.iter-report-body :deep(td) {
    border: 1px solid var(--border);
    padding: 4px 8px;
}
.iter-report-body :deep(th) {
    background: var(--bg-hover);
    font-weight: 600;
}
.iter-report-body :deep(hr) {
    border: none;
    border-top: 1px solid var(--border);
    margin: 0.9em 0;
}
</style>
