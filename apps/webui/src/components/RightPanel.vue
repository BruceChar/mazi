<script setup>
import { ref } from 'vue';
import LineIcon from '../assets/LineIcon.vue';
import {
    conicGradient,
    formatCost,
    formatPercent,
    formatRate,
    formatSigned,
    formatTokens,
} from '../scripts/audit.ts';

defineProps({
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
});
const emit = defineEmits([
    'update:activeTab',
    'toggleMaximize',
    'collapse',
    'update:activeEventType',
    'toggleShowAll',
    'select-step',
]);

function fmtClock(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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
function eventColorClass(type) {
    if (type?.startsWith('goal')) return 'ev-goal';
    if (type?.startsWith('task')) return 'ev-task';
    if (type?.startsWith('step')) return 'ev-step';
    return 'ev-other';
}
function eventSummary(e) {
    const p = e.payload || {};
    if (p.summary) return String(p.summary);
    if (p.error) return String(p.error);
    if (p.outcome?.status) return String(p.outcome.status);
    return '';
}

/* ---- Audit panel helpers (docs/web/观测看板设计.md v2) ---- */
function cacheHitRate(vendor) {
    const input = Number(vendor?.input ?? 0);
    return input > 0 ? formatPercent(Number(vendor?.cacheRead ?? 0) / input) : '0.0%';
}
function diffClass(delta) {
    if (delta === null || delta === undefined || delta === 0) return 'flat';
    return delta > 0 ? 'up' : 'down';
}
function donutStyle(segments) {
    return { background: conicGradient(segments) };
}
function vendorNonReasoning(vendor) {
    return Math.max(0, Number(vendor?.output ?? 0) - Number(vendor?.reasoning ?? 0));
}
function toFixed1(value) {
    const n = Number(value ?? 0);
    return Number.isFinite(n) ? n.toFixed(1) : '0.0';
}

/* ---- 分段落原文与 diff 展开状态 ---- */
const openSegments = ref(new Set());
const openDiff = ref(false);
function toggleSegment(key) {
    const next = new Set(openSegments.value);
    next.has(key) ? next.delete(key) : next.add(key);
    openSegments.value = next;
}
function toggleDiff() {
    openDiff.value = !openDiff.value;
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
                    <button :class="{ on: activeTab === 'log' }" @click="emit('update:activeTab', 'log')">日志</button>
                    <button :class="{ on: activeTab === 'events' }" @click="emit('update:activeTab', 'events')">事件</button>
                </div>
                <div class="drawer-head-actions">
                    <button class="icon-btn" :title="maximized ? '还原' : '最大化'" @click="emit('toggleMaximize')">
                        <LineIcon :name="maximized ? 'minimize' : 'maximize'" size="14" />
                    </button>
                </div>
            </div>

            <div v-if="activeTab === 'audit' && audit" class="drawer-body audit-body">
                <div class="audit-head">
                    <div class="audit-title">{{ audit.title }}</div>
                    <div v-if="audit.subtitle" class="audit-subtitle">{{ audit.subtitle }}</div>
                </div>

                <div v-if="audit.kind === 'none'" class="empty-hint">
                    {{ audit.stale ? '目标已失效，请重新选择 Step 或 Task' : '点击对话流中的 Step 或 Task 查看审计' }}
                </div>

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
                            Input 估算（breakdown）
                            <span v-if="audit.utilization != null" class="audit-pct">窗口 {{ formatPercent(audit.utilization) }}</span>
                        </div>
                        <template v-if="audit.segments.length">
                            <div class="donut-wrap">
                                <div class="donut" :style="donutStyle(audit.segments)">
                                    <div class="donut-hole">
                                        <span class="donut-num">{{ formatTokens(audit.usage.runtime ? audit.usage.runtime.totalContextTokens : null) }}</span>
                                        <span class="donut-cap">估算 input</span>
                                    </div>
                                </div>
                            </div>
                            <template v-for="seg in audit.segments" :key="seg.key">
                                <button
                                    class="seg-row"
                                    :class="{ open: openSegments.has(seg.key) }"
                                    :title="'查看 ' + seg.label + ' 原文'"
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

                        <div v-if="audit.utilization != null" class="context-bar">
                            <div class="context-bar-fill" :style="{ width: Math.min(100, audit.utilization * 100) + '%' }"></div>
                        </div>

                        <div v-if="audit.diff" class="audit-row">
                            <span class="audit-key">context diff</span>
                            <span class="audit-val audit-diff" :class="diffClass(audit.diff.delta)">{{ formatSigned(audit.diff.delta) }}（{{ formatTokens(audit.diff.from) }} → {{ formatTokens(audit.diff.to) }}）</span>
                        </div>
                        <button v-if="audit.diffContent" class="diff-toggle" @click="toggleDiff">
                            {{ openDiff ? '收起' : '查看' }}与上一轮相比的新增内容
                        </button>
                        <pre v-if="openDiff && audit.diffContent" class="seg-content">{{ audit.diffContent }}</pre>

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

                    <!-- 输出估算 -->
                    <section class="audit-section">
                        <div class="audit-section-title">输出估算</div>
                        <template v-if="audit.usage.estimate">
                            <div class="audit-row"><span class="audit-key">estimate output</span><span class="audit-val">{{ formatTokens(audit.usage.estimate.outputTotal) }}</span></div>
                            <div v-if="audit.usage.vendor" class="audit-row"><span class="audit-key">vendor output（非 reasoning）</span><span class="audit-val">{{ formatTokens(vendorNonReasoning(audit.usage.vendor)) }}</span></div>
                            <div class="audit-row">
                                <span class="audit-key">output 漂移</span>
                                <span class="audit-val" :class="diffClass(audit.usage.estimate.outputDrift)">
                                    {{ formatSigned(audit.usage.estimate.outputDrift) }}
                                    <span class="audit-note-inline">{{ formatRate(audit.usage.estimate.outputDriftRate) }}</span>
                                </span>
                            </div>
                            <div v-if="audit.estimatedTotal != null" class="audit-row audit-total">
                                <span class="audit-key">估算总量 / vendor total</span>
                                <span class="audit-val">{{ formatTokens(audit.estimatedTotal) }} / {{ audit.vendorTotal != null ? formatTokens(audit.vendorTotal) : '-' }}</span>
                            </div>
                        </template>
                        <div v-else class="audit-muted">无输出估算</div>
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
                        </template>
                        <div v-else class="audit-muted">未计价</div>
                    </section>

                    <!-- Timing -->
                    <section class="audit-section">
                        <div class="audit-section-title">Timing</div>
                        <template v-if="audit.usage.timing">
                            <div class="audit-row"><span class="audit-key">TTFT</span><span class="audit-val">{{ formatDuration(audit.usage.timing.ttftMs) }}</span></div>
                            <div class="audit-row"><span class="audit-key">Total</span><span class="audit-val">{{ formatDuration(audit.usage.timing.totalMs) }}</span></div>
                            <div class="audit-row"><span class="audit-key">速率</span><span class="audit-val">{{ toFixed1(audit.usage.timing.tokensPerSecond) }} tok/s</span></div>
                        </template>
                        <div v-else class="audit-muted">暂无耗时</div>
                    </section>

                    <!-- 步骤明细（会话流全局线 / 单个 Task） -->
                    <section v-if="audit.rows.length" class="audit-section">
                        <div class="audit-section-title">
                            {{ audit.kind === 'task' ? '步骤' : '会话步骤' }}（{{ audit.rows.length }}）
                        </div>
                        <button
                            v-for="row in audit.rows"
                            :key="row.stepId"
                            class="audit-step-row"
                            :class="{ selected: row.selected }"
                            @click="emit('select-step', { stepId: row.stepId })"
                        >
                            <span class="audit-step-tag">S#{{ row.lineIndex }}</span>
                            <span v-if="audit.kind !== 'task'" class="audit-run-tag">R#{{ row.runIndex }}</span>
                            <span class="audit-step-kind">{{ row.toolName || row.kind }}</span>
                            <span class="audit-step-ctx">{{ row.contextTotal != null ? formatTokens(row.contextTotal) : '-' }}</span>
                            <span class="audit-step-delta" :class="diffClass(row.contextDelta)">{{ formatSigned(row.contextDelta) }}</span>
                            <span class="audit-step-tokens">{{ formatTokens(row.tokens) }}</span>
                        </button>
                    </section>
                </template>
            </div>
            <div v-else-if="activeTab === 'log'" class="drawer-body">
                <div v-if="current" class="exec-log">
                    <div v-if="rootOutcome" class="log-result" :class="rootOutcome.ok ? 'ok' : 'fail'">
                        <div class="log-line">
                            <span class="log-tag">{{ rootOutcome.ok ? '成功' : '失败' }}</span>
                            <span class="log-reason">reason: {{ rootOutcome.reason || '-' }}</span>
                        </div>
                        <div class="log-msg">{{ rootOutcome.ok ? rootOutcome.finalMessage : rootOutcome.errorMessage }}</div>
                    </div>
                    <div v-if="busy && !rootOutcome" class="empty-hint">执行中…（流式步骤实时到达）</div>

                    <template v-if="stepRows.length">
                        <div class="log-head">
                            <span>步骤（{{ stepRows.length }}）</span>
                            <span class="log-head-total">
                                总耗时 {{ formatDuration(stepRows.reduce((s, r) => s + (r.durationMs || 0), 0)) }}
                            </span>
                        </div>
                        <div v-for="line in stepRows" :key="line.key" class="kanban-card" :class="`kanban-${line.kind}`">
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
                    <select :value="activeEventType" @change="emit('update:activeEventType', $event.target.value)" title="事件类型">
                        <option v-for="t in eventTypes" :key="t" :value="t">{{ t }}</option>
                    </select>
                    <button class="ev-toggle" :class="{ on: showAllEvents }" @click="emit('toggleShowAll')">
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
    width: 340px;
    flex-basis: 340px;
    border-left-width: 1px;
}
.right-panel.maximized {
    flex: 1 1 auto;
    width: auto !important;
    min-width: 0 !important;
    position: static;
    border-left: 1px solid var(--border);
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
.event-row:hover {
    background: var(--bg-hover);
}
.ev-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
}
.ev-goal { background: #8b5cf6; }
.ev-task { background: #3b82f6; }
.ev-step { background: #10b981; }
.ev-other { background: var(--fg-tertiary); }
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
    border-bottom: 1px solid var(--border-soft);
    padding-bottom: 8px;
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
.audit-step-kind {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg);
}
.audit-step-ctx,
.audit-step-delta,
.audit-step-tokens {
    font-family: ui-monospace, monospace;
    flex-shrink: 0;
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
/* Donut (conic-gradient pie) for input breakdown */
.donut-wrap {
    display: flex;
    justify-content: center;
    margin-bottom: 8px;
}
.donut {
    width: 108px;
    height: 108px;
    border-radius: 50%;
    display: grid;
    place-items: center;
}
.donut-hole {
    width: 72px;
    height: 72px;
    border-radius: 50%;
    background: var(--bg-panel);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1px;
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
.seg-row.open {
    background: var(--bg-hover);
}
.seg-caret {
    display: inline-grid;
    place-items: center;
    color: var(--fg-tertiary);
    flex-shrink: 0;
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
