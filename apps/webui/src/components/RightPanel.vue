<script setup>
import { computed, ref } from 'vue';
import LineIcon from '../assets/LineIcon.vue';
import {
    donutArcs,
    formatBytes,
    formatCost,
    formatPercent,
    formatRate,
    formatSigned,
    formatTokens,
} from '../scripts/audit.ts';

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
    /** 整条会话流的步骤行（Context 追踪用，不随选择变化）。 */
    contextRows: { type: Array, default: () => [] },
    /** 进程内系统日志（GET /api/logs）：错误/告警/信息。 */
    systemLogs: { type: Array, default: () => [] },
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
    'refresh-logs',
]);

function fmtClock(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
/** 日期+时间（步骤/任务起始用；同日内也带毫秒感知的完整时刻）。 */
function fmtDateTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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
/* ---- 日志：系统日志视图（事件面板暂时下线，待系统/会话流梳理清楚） ---- */
const LOG_LEVELS = [
    { value: 'all', label: '全部' },
    { value: 'error', label: '错误' },
    { value: 'warn', label: '告警' },
    { value: 'info', label: '信息' },
    { value: 'debug', label: '调试' },
];
const logLevel = ref('all');

/** 日志 hover 弹窗（宽度不足时查看完整内容）。 */
const logTip = ref(null);
function showLogTip(event, text) {
    logTip.value = { text, x: event.clientX, y: event.clientY };
}
function hideLogTip() {
    logTip.value = null;
}

const systemLogRows = computed(() => {
    const list = props.systemLogs || [];
    const filtered =
        logLevel.value === 'all' ? list : list.filter((entry) => entry.level === logLevel.value);
    return filtered.slice().reverse();
});


/* ---- Audit panel helpers (docs/web/观测看板设计.md v2) ---- */
function cacheHitRate(vendor) {
    const input = Number(vendor?.input ?? 0);
    return input > 0 ? formatPercent(Number(vendor?.cacheRead ?? 0) / input) : '0.0%';
}
function diffClass(delta) {
    if (delta === null || delta === undefined || delta === 0) return 'flat';
    return delta > 0 ? 'up' : 'down';
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

/* ---- 分段落原文 / diff 展开 ---- */
const openSegments = ref(new Set());
const openDiff = ref(false);
const openContext = ref(new Set());
function toggleSegment(key) {
    const next = new Set(openSegments.value);
    next.has(key) ? next.delete(key) : next.add(key);
    openSegments.value = next;
}
function toggleDiff() {
    openDiff.value = !openDiff.value;
}
function toggleContext(key) {
    const next = new Set(openContext.value);
    next.has(key) ? next.delete(key) : next.add(key);
    openContext.value = next;
}

/* ---- Context 追踪：分段堆叠增长条 ---- */
const contextRowList = computed(() => props.contextRows || []);
const contextUtil = computed(() => props.audit?.utilization ?? null);
/** 对 context 无影响的步骤（工具调用等）：不进图表，折叠成一行一个。 */
const contextModelRows = computed(() =>
    contextRowList.value.filter((row) => row.contextTotal != null),
);
const contextToolRows = computed(() =>
    contextRowList.value.filter((row) => row.contextTotal == null),
);
const openToolGroups = ref(new Set());
function toggleToolGroup(key) {
    const next = new Set(openToolGroups.value);
    next.has(key) ? next.delete(key) : next.add(key);
    openToolGroups.value = next;
}
const contextPeak = computed(() =>
    contextModelRows.value.reduce((max, row) => Math.max(max, row.contextTotal || 0), 0),
);
const contextLatest = computed(() => {
    const rows = contextModelRows.value;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
        const total = rows[i]?.contextTotal;
        if (total != null) return total;
    }
    return 0;
});
const contextLegend = computed(() => {
    const seen = new Map();
    for (const row of contextModelRows.value) {
        for (const seg of row.segments || []) {
            if (!seen.has(seg.key)) {
                seen.set(seg.key, { key: seg.key, label: seg.label, colorVar: seg.colorVar });
            }
        }
    }
    return [...seen.values()];
});
/** 按模型轮分组：每个有 context 的 step 一组，其后的工具调用挂在组内（即在对应 thinking 之下）。 */
const contextGroups = computed(() => {
    const max = Math.max(1, contextPeak.value);
    const groups = [];
    let current = null;
    for (const row of contextRowList.value) {
        if (row.contextTotal != null) {
            current = {
                key: row.stepId,
                row: {
                    ...row,
                    barWidth: Math.min(100, ((row.contextTotal || 0) / max) * 100),
                    segs: (row.segments || []).map((seg) => ({
                        key: seg.key,
                        label: seg.label,
                        colorVar: seg.colorVar,
                        tokens: seg.tokens,
                        width: row.contextTotal ? (seg.tokens / row.contextTotal) * 100 : 0,
                    })),
                },
                tools: [],
            };
            groups.push(current);
        } else {
            if (current === null) {
                current = { key: 'lead:' + groups.length, row: null, tools: [] };
                groups.push(current);
            }
            current.tools.push(row);
        }
    }
    return groups;
});

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
    return `$${perMTok}/M`;
}
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
                    <button :class="{ on: activeTab === 'audit' }" @click="emit('update:activeTab', 'audit')">审计</button>
                    <button :class="{ on: activeTab === 'context' }" @click="emit('update:activeTab', 'context')">Context</button>
                    <button :class="{ on: activeTab === 'log' }" @click="emit('update:activeTab', 'log')">日志</button>
                </div>
                <div class="drawer-head-actions">
                    <button class="icon-btn" :title="maximized ? '还原' : '最大化'" @click="emit('toggleMaximize')">
                        <LineIcon :name="maximized ? 'minimize' : 'maximize'" size="14" />
                    </button>
                </div>
            </div>

            <div v-if="activeTab === 'audit' && audit" class="drawer-body audit-body audit-grid">
                <div class="audit-head">
                    <div class="audit-head-main">
                        <div class="audit-title">{{ audit.title }}</div>
                        <div v-if="audit.subtitle" class="audit-subtitle">{{ audit.subtitle }}</div>
                    </div>
                    <button
                        class="audit-info-btn"
                        :class="{ on: audit.kind === 'conversation' }"
                        title="会话汇总（清空 Step/Task 选择）"
                        @click="emit('select-conversation')"
                    >
                        <LineIcon name="info" size="14" />
                    </button>
                </div>

                <div v-if="audit.kind === 'none'" class="empty-hint">
                    {{ audit.stale ? '目标已失效，请重新选择 Step 或 Task' : '点击对话流中的 Step 或 Task 查看审计' }}
                </div>

                <template v-else>
                    <!-- 工具调用：专用审计 view（命令/参数/输出/耗时），不显示 vendor token -->
                    <section v-if="audit.tool" class="audit-section">
                        <div class="audit-section-title">工具调用 · {{ audit.tool.name }}</div>
                        <div class="audit-row"><span class="audit-key">工作路径 / 命令</span><span class="audit-val audit-mono">{{ audit.tool.line || audit.tool.name }}</span></div>
                        <div v-if="audit.tool.arguments && Object.keys(audit.tool.arguments).length" class="audit-tool-block">
                            <div class="audit-key">参数</div>
                            <pre class="seg-content">{{ JSON.stringify(audit.tool.arguments, null, 2) }}</pre>
                        </div>
                        <div class="audit-row"><span class="audit-key">耗时</span><span class="audit-val">{{ formatDuration(audit.tool.durationMs) || '-' }}</span></div>
                        <div v-if="audit.startedAt" class="audit-row"><span class="audit-key">开始</span><span class="audit-val">{{ fmtDateTime(audit.startedAt) }}</span></div>
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

                        <div v-if="audit.contextBytes != null" class="audit-row">
                            <span class="audit-key">实际 context</span>
                            <span class="audit-val">{{ formatBytes(audit.contextBytes) }}</span>
                        </div>

                        <div v-if="audit.diff" class="audit-row">
                            <span class="audit-key">context diff</span>
                            <span class="audit-val audit-diff" :class="diffClass(audit.diff.delta)">{{ formatSigned(audit.diff.delta) }}（{{ formatTokens(audit.diff.from) }} → {{ formatTokens(audit.diff.to) }}）</span>
                        </div>
                        <div v-if="audit.diffParts.length" class="audit-diff-parts">
                            <div class="audit-section-sub">与上一轮相比的新增内容</div>
                            <template v-for="part in audit.diffParts" :key="part.key">
                                <div class="ctx-diff-label">{{ part.label }}</div>
                                <pre class="seg-content">{{ part.text }}</pre>
                            </template>
                        </div>

                        <div v-if="audit.usage.estimate" class="audit-row">
                            <span class="audit-key">input 漂移</span>
                            <span class="audit-val" :class="diffClass(audit.usage.estimate.inputDrift)">
                                {{ formatSigned(audit.usage.estimate.inputDrift) }}
                                <span class="audit-note-inline">{{ formatRate(audit.usage.estimate.inputDriftRate) }}</span>
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

                    <!-- Cost 双口径 -->
                    <section class="audit-section">
                        <div class="audit-section-title">Cost</div>
                        <template v-if="audit.usage.cost">
                            <div class="audit-row"><span class="audit-key">vendor</span><span class="audit-val">{{ formatCost(audit.usage.cost.total) }}</span></div>
                            <div v-if="audit.usage.estimatedCost" class="audit-row"><span class="audit-key">估算</span><span class="audit-val">{{ formatCost(audit.usage.estimatedCost.total) }}</span></div>
                            <div v-if="audit.costDrift" class="audit-row">
                                <span class="audit-key">漂移</span>
                                <span class="audit-val" :class="diffClass(audit.costDrift.usd)">
                                    {{ formatCost(audit.costDrift.usd) }}
                                    <span class="audit-note-inline">{{ formatRate(audit.costDrift.rate) }}</span>
                                </span>
                            </div>
                            <div class="audit-row"><span class="audit-key">in / out</span><span class="audit-val">{{ formatCost(audit.usage.cost.input) }} / {{ formatCost(audit.usage.cost.output) }}</span></div>
                            <div v-if="audit.usage.cost.cacheRead || audit.usage.cost.cacheWrite" class="audit-row"><span class="audit-key">cache</span><span class="audit-val">{{ formatCost(audit.usage.cost.cacheRead + audit.usage.cost.cacheWrite) }}</span></div>
                            <div v-if="audit.usage.cost.reasoning" class="audit-row"><span class="audit-key">reasoning</span><span class="audit-val">{{ formatCost(audit.usage.cost.reasoning) }}</span></div>
                            <div v-if="audit.usage.cost.tier" class="audit-row"><span class="audit-key">tier</span><span class="audit-val">{{ audit.usage.cost.tier }}</span></div>

                            <!-- vendor 分解：按 vendor token + 入库计价快照重算 -->
                            <template v-if="audit.vendorCost">
                                <div class="audit-section-sub">vendor 分解</div>
                                <div class="audit-row"><span class="audit-key">input missed</span><span class="audit-val">{{ formatCost(audit.vendorCost.inputMissedUsd) }} <span class="audit-note-inline">{{ formatTokens(audit.vendorCost.inputMissedTokens) }} tok</span></span></div>
                                <div class="audit-row"><span class="audit-key">input cached</span><span class="audit-val">{{ formatCost(audit.vendorCost.inputCachedUsd) }} <span class="audit-note-inline">{{ formatTokens(audit.vendorCost.inputCachedTokens) }} tok</span></span></div>
                                <div class="audit-row"><span class="audit-key">reasoning</span><span class="audit-val">{{ formatCost(audit.vendorCost.reasoningUsd) }} <span class="audit-note-inline">{{ formatTokens(audit.vendorCost.reasoningTokens) }} tok</span></span></div>
                                <div class="audit-row"><span class="audit-key">tool-call args</span><span class="audit-val">{{ formatCost(audit.vendorCost.toolCallArgsUsd) }} <span class="audit-note-inline">{{ formatTokens(audit.vendorCost.toolCallArgsTokens) }} tok</span></span></div>
                                <div class="audit-row"><span class="audit-key">text</span><span class="audit-val">{{ formatCost(audit.vendorCost.textUsd) }} <span class="audit-note-inline">{{ formatTokens(audit.vendorCost.textTokens) }} tok</span></span></div>
                                <div class="audit-row audit-total"><span class="audit-key">vendor 合计</span><span class="audit-val">{{ formatCost(audit.vendorCost.totalUsd) }}</span></div>
                                <div class="audit-row">
                                    <span class="audit-key">pricing</span>
                                    <span class="audit-val audit-muted">
                                        in {{ pricingRate(audit.vendorCost.pricing.inputPerMTok) }} · cached {{ pricingRate(audit.vendorCost.pricing.cachedInputPerMTok) }} · out {{ pricingRate(audit.vendorCost.pricing.outputPerMTok) }}
                                        <span v-if="audit.vendorCost.pricing.version" class="audit-note-inline">{{ audit.vendorCost.pricing.version }}</span>
                                    </span>
                                </div>
                            </template>
                        </template>
                        <div v-else class="audit-muted">未计价</div>
                    </section>

                    <!-- Timing -->
                    <section class="audit-section">
                        <div class="audit-section-title">Timing</div>
                        <div v-if="audit.startedAt" class="audit-row"><span class="audit-key">开始</span><span class="audit-val">{{ fmtDateTime(audit.startedAt) }}</span></div>
                        <div v-if="audit.endedAt" class="audit-row"><span class="audit-key">结束</span><span class="audit-val">{{ fmtDateTime(audit.endedAt) }}</span></div>
                        <template v-if="audit.usage.timing">
                            <div class="audit-row"><span class="audit-key">TTFT</span><span class="audit-val">{{ formatDuration(audit.usage.timing.ttftMs) }}</span></div>
                            <div class="audit-row"><span class="audit-key">Total</span><span class="audit-val">{{ formatDuration(audit.usage.timing.totalMs) }}</span></div>
                            <div class="audit-row"><span class="audit-key">速率</span><span class="audit-val">{{ toFixed1(audit.usage.timing.tokensPerSecond) }} tok/s</span></div>
                        </template>
                        <div v-if="!audit.startedAt && !audit.usage.timing" class="audit-muted">暂无耗时</div>
                    </section>

                    </template>

                    <!-- 步骤明细（会话流全局线 / 单个 Task） -->
                    <section v-if="audit.rows.length" class="audit-section audit-span">
                        <div class="audit-section-title">
                            {{ audit.kind === 'task' ? '步骤' : '会话步骤' }}（{{ audit.rows.length }}）
                        </div>
                        <div class="audit-step-head">
                            <span class="audit-step-loc">位置</span>
                            <span class="audit-step-kind">类型</span>
                            <span class="audit-step-start">开始</span>
                            <span class="audit-step-ctx">上下文</span>
                            <span class="audit-step-delta">Δ</span>
                            <span class="audit-step-tokens">tokens</span>
                            <span class="audit-step-rate">速率</span>
                        </div>
                        <button
                            v-for="row in audit.rows"
                            :key="row.stepId"
                            class="audit-step-row"
                            :class="{ selected: row.selected }"
                            @click="emit('locate-step', { stepId: row.stepId })"
                        >
                            <span class="audit-step-loc">R#{{ row.runIndex }}·T#{{ row.taskIndex }}·S#{{ row.index }}</span>
                            <span class="audit-step-kind">{{ row.toolName || row.kind }}</span>
                            <span class="audit-step-start">{{ fmtClock(row.startedAt) }}</span>
                            <span class="audit-step-ctx">{{ row.contextTotal != null ? formatTokens(row.contextTotal) : '-' }}</span>
                            <span class="audit-step-delta" :class="diffClass(row.contextDelta)">{{ formatSigned(row.contextDelta) }}</span>
                            <span class="audit-step-tokens">{{ formatTokens(row.tokens) }}</span>
                            <span class="audit-step-rate">{{ row.tokensPerSecond != null ? toFixed1(row.tokensPerSecond) : '-' }}</span>
                        </button>
                    </section>
                </template>
            </div>
            <div v-else-if="activeTab === 'context'" class="drawer-body audit-body context-body">
                <section class="audit-section">
                    <div class="audit-section-title">
                        Context 追踪
                        <span class="audit-pct">{{ contextModelRows.length }} 步 · {{ contextToolRows.length }} 工具</span>
                    </div>
                    <div class="ctx-summary">
                        <span>峰值 {{ formatTokens(contextPeak) }}</span>
                        <span>最新 {{ formatTokens(contextLatest) }}</span>
                        <span v-if="contextUtil != null">context ratio {{ formatPercent(contextUtil) }}</span>
                        <span v-if="audit?.contextBytes != null">实际 {{ formatBytes(audit.contextBytes) }}</span>
                    </div>
                    <div class="ctx-legend">
                        <span v-for="seg in contextLegend" :key="seg.key" class="ctx-legend-item">
                            <span class="seg-dot" :style="{ background: 'var(' + seg.colorVar + ')' }"></span>{{ seg.label }}
                        </span>
                    </div>
                </section>

                <section class="audit-section">
                    <div v-for="group in contextGroups" :key="group.key" class="ctx-item">
                        <!-- 双击定位主会话流（保留 Context 面板）；hover 才显示折叠 icon，单击它折叠/展开 -->
                        <div
                            v-if="group.row"
                            class="ctx-row"
                            :class="{ selected: group.row.selected }"
                            @dblclick="emit('locate-step', { stepId: group.row.stepId, keepTab: true })"
                        >
                            <button
                                class="ctx-caret-btn"
                                :title="openContext.has(group.row.stepId) ? '收起 diff' : '展开该步 diff'"
                                @click.stop="toggleContext(group.row.stepId)"
                            >
                                {{ openContext.has(group.row.stepId) ? '−' : '+' }}
                            </button>
                            <span class="ctx-loc">R#{{ group.row.runIndex }}·T#{{ group.row.taskIndex }}·S#{{ group.row.index }}</span>
                            <span class="ctx-kind">{{ group.row.toolName || group.row.kind }}</span>
                            <div class="ctx-bar">
                                <div class="ctx-bar-fill" :style="{ width: group.row.barWidth + '%' }">
                                    <span
                                        v-for="seg in group.row.segs"
                                        :key="seg.key"
                                        class="ctx-seg"
                                        :style="{ width: seg.width + '%', background: 'var(' + seg.colorVar + ')' }"
                                        :title="seg.label + ' · ' + formatTokens(seg.tokens)"
                                    ></span>
                                </div>
                            </div>
                            <span class="ctx-total">{{ group.row.contextTotal != null ? formatTokens(group.row.contextTotal) : '-' }}</span>
                            <span class="ctx-delta" :class="diffClass(group.row.contextDelta)">{{ formatSigned(group.row.contextDelta) }}</span>
                        </div>
                        <div v-if="group.row && openContext.has(group.row.stepId)" class="ctx-diff">
                            <template v-for="part in group.row.diffParts" :key="part.key">
                                <div class="ctx-diff-label">{{ part.label }}</div>
                                <pre class="seg-content">{{ part.text }}</pre>
                            </template>
                            <div v-if="!group.row.diffParts.length" class="audit-muted">（本步无新增内容）</div>
                        </div>
                        <!-- 该模型轮产生的工具调用：折叠在对应 thinking 之下（不是独立面板） -->
                        <div v-if="group.tools.length" class="ctx-tools-inline">
                            <button class="ctx-tools-toggle" @click="toggleToolGroup(group.key)">
                                <span class="ctx-tools-caret">{{ openToolGroups.has(group.key) ? '−' : '+' }}</span>
                                工具调用（{{ group.tools.length }}）
                            </button>
                            <div v-if="openToolGroups.has(group.key)">
                                <button
                                    v-for="tool in group.tools"
                                    :key="tool.stepId"
                                    class="ctx-tool-line"
                                    :class="{ selected: tool.selected }"
                                    @dblclick="emit('locate-step', { stepId: tool.stepId, keepTab: true })"
                                >
                                    <span class="ctx-loc">R#{{ tool.runIndex }}·T#{{ tool.taskIndex }}·S#{{ tool.index }}</span>
                                    <span class="ctx-tool-text">{{ tool.toolLine }}</span>
                                </button>
                            </div>
                        </div>
                    </div>
                    <div v-if="!contextModelRows.length" class="audit-muted">暂无可追踪的步骤</div>
                </section>
            </div>
            <div v-else class="drawer-body">
                <div class="drawer-tabs sub">
                    <select v-model="logLevel" title="日志级别">
                        <option v-for="l in LOG_LEVELS" :key="l.value" :value="l.value">{{ l.label }}</option>
                    </select>
                    <button class="ev-toggle" @click="emit('refresh-logs')">刷新</button>
                    <span class="log-count">{{ systemLogRows.length }} 条</span>
                </div>
                <div class="event-log">
                    <div
                        v-for="row in systemLogRows"
                        :key="row.id"
                        class="event-row log-row"
                        @mouseenter="showLogTip($event, row.message)"
                        @mousemove="showLogTip($event, row.message)"
                        @mouseleave="hideLogTip"
                    >
                        <span class="ev-dot" :class="'ev-' + row.level"></span>
                        <span class="event-time">{{ fmtClock(row.ts) }}</span>
                        <span class="event-type" :class="'ev-' + row.level">{{ row.level }}</span>
                        <span class="event-module">{{ row.module }}</span>
                        <span class="event-summary">{{ row.message }}</span>
                    </div>
                    <div v-if="!systemLogRows.length" class="empty-hint">暂无系统日志</div>
                </div>
            </div>
            <!-- 日志 hover 弹窗：宽度不足时显示完整内容 -->
            <div
                v-if="logTip"
                class="log-tooltip"
                :style="{ left: logTip.x + 12 + 'px', top: logTip.y + 12 + 'px' }"
            >{{ logTip.text }}</div>
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
@media (min-width: 1180px) {
    .right-panel.maximized .audit-grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        column-gap: 32px;
        align-content: start;
    }
    .right-panel.maximized .audit-grid > .audit-section {
        margin-bottom: 6px;
    }
    .right-panel.maximized .audit-grid > .audit-span {
        grid-column: 1 / -1;
        margin-top: 10px;
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

/* Step detail rows (click to re-select) */
.audit-step-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 6px;
    font-size: 10px;
    color: var(--fg-tertiary);
    border-bottom: 1px solid var(--border-soft);
    margin-bottom: 2px;
}
.audit-step-head .audit-step-loc {
    background: transparent;
    color: var(--fg-tertiary);
}
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
.audit-step-row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 4px 6px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--fg-secondary);
    font-size: 11px;
    text-align: left;
    cursor: pointer;
}
.audit-step-row:hover {
    background: var(--bg-hover);
    color: var(--fg-secondary);
}
.audit-step-row.selected {
    background: var(--accent-soft);
}
.audit-step-tag {
    font-family: ui-monospace, monospace;
    font-weight: 700;
    color: var(--fg-tertiary);
    background: var(--bg-code);
    border-radius: 3px;
    padding: 0 4px;
    width: 32px;
    text-align: center;
    flex-shrink: 0;
}
.audit-run-tag {
    font-family: ui-monospace, monospace;
    font-size: 10px;
    color: var(--fg-tertiary);
    background: var(--bg-hover);
    border-radius: 3px;
    padding: 0 3px;
    flex-shrink: 0;
}
.audit-step-task {
    font-family: ui-monospace, monospace;
    font-weight: 700;
    color: var(--fg-tertiary);
    background: var(--bg-code);
    border-radius: 3px;
    padding: 0 4px;
    width: 32px;
    text-align: center;
    flex-shrink: 0;
}
.audit-step-kind {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg);
}
.audit-step-ctx,
.audit-step-delta,
.audit-step-tokens,
.audit-step-start,
.audit-step-rate {
    font-family: ui-monospace, monospace;
    flex-shrink: 0;
}
.audit-step-start {
    color: var(--fg-tertiary);
    min-width: 54px;
}
.audit-step-rate {
    color: var(--fg-tertiary);
    min-width: 38px;
    text-align: right;
}
.audit-step-delta {
    min-width: 44px;
    text-align: right;
}
.audit-step-delta.up { color: var(--ok); }
.audit-step-delta.down { color: var(--warn); }
.audit-step-delta.flat { color: var(--fg-tertiary); }
.audit-step-tokens {
    min-width: 48px;
    text-align: right;
    color: var(--fg-tertiary);
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
/* Context 面板：步骤列表贴近边框（缩小外层与区块左内边距）。 */
.context-body {
    padding: 8px 4px 8px 6px;
    gap: 8px;
}
.context-body .audit-section {
    padding: 6px 4px;
}
.context-body .ctx-tools-inline {
    margin-left: 10px;
}
.ctx-item {
    margin-bottom: 2px;
}
.ctx-row {
    display: grid;
    grid-template-columns: 18px minmax(96px, 122px) minmax(52px, 84px) 1fr 52px 44px;
    align-items: center;
    gap: 4px;
    padding: 2px 4px;
    border-radius: 4px;
    font-size: 11px;
    cursor: pointer;
}
.ctx-row:hover,
.ctx-row.selected {
    background: var(--bg-hover);
}
.ctx-caret-btn {
    width: 18px;
    height: 18px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--fg-tertiary);
    font-weight: 700;
    line-height: 1;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.1s ease;
}
.ctx-row:hover .ctx-caret-btn {
    opacity: 1;
}
.ctx-caret-btn:hover {
    background: var(--bg-code);
    color: var(--fg);
}
.ctx-loc {
    font-family: ui-monospace, monospace;
    font-size: 10px;
    color: var(--fg-tertiary);
    white-space: nowrap;
    cursor: pointer;
}
.ctx-loc:hover {
    color: var(--fg);
}
.ctx-tools-inline {
    margin-left: 22px;
}
.ctx-kind {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg);
}
.ctx-bar {
    height: 12px;
    border-radius: 3px;
    background: var(--bg-code);
    overflow: hidden;
    cursor: default;
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
.ctx-total,
.ctx-delta {
    font-family: ui-monospace, monospace;
    text-align: right;
}
.ctx-total {
    color: var(--fg-secondary);
}
.ctx-delta.up { color: var(--ok); }
.ctx-delta.down { color: var(--warn); }
.ctx-delta.flat { color: var(--fg-tertiary); }
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
.ctx-tools-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 4px 6px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--fg-tertiary);
    font-size: 11px;
    text-align: left;
    cursor: pointer;
}
.ctx-tools-toggle:hover {
    background: var(--bg-hover);
}
.ctx-tools-caret {
    font-weight: 700;
    opacity: 0;
    transition: opacity 0.1s ease;
}
.ctx-tools-toggle:hover .ctx-tools-caret {
    opacity: 1;
}
.ctx-tool-line {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 3px 6px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--fg-secondary);
    font-size: 11px;
    text-align: left;
    cursor: pointer;
}
.ctx-tool-line:hover,
.ctx-tool-line.selected {
    background: var(--bg-hover);
}
.ctx-tool-text {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, monospace;
    color: var(--fg-secondary);
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
</style>
