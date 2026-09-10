<script setup>
import LineIcon from '../LineIcon.vue';

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
});
const emit = defineEmits([
    'update:activeTab',
    'toggleMaximize',
    'collapse',
    'update:activeEventType',
    'toggleShowAll',
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
                    <button :class="{ on: activeTab === 'log' }" @click="emit('update:activeTab', 'log')">日志</button>
                    <button :class="{ on: activeTab === 'events' }" @click="emit('update:activeTab', 'events')">事件</button>
                </div>
                <div class="drawer-head-actions">
                    <button class="icon-btn" :title="maximized ? '还原' : '最大化'" @click="emit('toggleMaximize')">
                        <LineIcon :name="maximized ? 'minimize' : 'maximize'" size="14" />
                    </button>
                </div>
            </div>

            <div v-if="activeTab === 'log'" class="drawer-body">
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
</style>
