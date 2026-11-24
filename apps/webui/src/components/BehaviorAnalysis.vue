<script setup>
/**
 * BehaviorAnalysis — 用户中心 → 行为链 → 行为分析。
 *
 * 只展示用户的**授权**（允许/拒绝）与**反馈**（赞/踩）两类行为；提问不展示。
 * 审批请求（approval）是 harness 发起的锚点，不单独成行，由授权行经 ref.ts
 * 内联其工具/摘要/invocationId，形成完整证据链。支持类型 / 结果 / 时间筛选。
 */
import { computed, onMounted, ref } from 'vue';
import { fetchUserBehaviors } from '../scripts/store.ts';
import {
    KIND_OPTIONS,
    RESULT_OPTIONS,
    applyBehaviorFilter,
    authorizationEvidence,
    classifyResult,
    summarize,
} from '../scripts/behavior-audit.ts';

const behaviors = ref([]);
const loading = ref(true);
const error = ref('');

const filters = ref({
    kind: '',
    result: '',
    from: '',
    to: '',
});

function dayStart(value) {
    if (!value) return undefined;
    return new Date(value + 'T00:00:00').getTime();
}
function dayEnd(value) {
    if (!value) return undefined;
    const date = new Date(value + 'T00:00:00');
    date.setDate(date.getDate() + 1);
    return date.getTime() - 1;
}

/** 审批锚点按 ts 建索引，供授权内联证据（锚点不进入筛选结果）。 */
const approvalByTs = computed(() => {
    const map = new Map();
    for (const behavior of behaviors.value) {
        if (behavior.type === 'approval') map.set(behavior.ts, behavior);
    }
    return map;
});

const filtered = computed(() =>
    applyBehaviorFilter(behaviors.value, {
        kind: filters.value.kind || undefined,
        result: filters.value.result || undefined,
        from: dayStart(filters.value.from),
        to: dayEnd(filters.value.to),
    }),
);

const summary = computed(() => summarize(filtered.value));
const visible = computed(() => [...filtered.value].sort((a, b) => b.ts - a.ts));

function resetFilters() {
    filters.value = { kind: '', result: '', from: '', to: '' };
}

function fmtTime(ts) {
    return new Date(ts).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
}

function resultOf(row) {
    return classifyResult(row);
}

function evidenceOf(row) {
    return authorizationEvidence(row, approvalByTs.value);
}

function fmtLatency(ms) {
    return typeof ms === 'number' ? `${ms}ms` : '';
}

onMounted(async () => {
    try {
        behaviors.value = await fetchUserBehaviors('all');
    } catch (e) {
        error.value = String(e);
    } finally {
        loading.value = false;
    }
});
</script>

<template>
    <div class="uc-panel">
        <div class="uc-meta">
            <span class="behavior-badge">{{ summary.total }} 条</span>
        </div>

        <div class="ba-summary">
            <div class="ba-stat"><span class="ba-num">{{ summary.allowed }}</span><span class="ba-cap">允许</span></div>
            <div class="ba-stat"><span class="ba-num">{{ summary.denied }}</span><span class="ba-cap">拒绝</span></div>
            <div class="ba-stat"><span class="ba-num">{{ summary.up }}</span><span class="ba-cap">赞</span></div>
            <div class="ba-stat"><span class="ba-num">{{ summary.down }}</span><span class="ba-cap">踩</span></div>
        </div>

        <div class="ba-filters">
            <select v-model="filters.kind" class="ba-input" title="按类型筛选">
                <option value="">全部类型</option>
                <option v-for="opt in KIND_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>
            <select v-model="filters.result" class="ba-input" title="按结果筛选">
                <option value="">全部结果</option>
                <option v-for="opt in RESULT_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>
            <input v-model="filters.from" class="ba-input" type="date" title="起始日期" />
            <input v-model="filters.to" class="ba-input" type="date" title="结束日期" />
            <button class="ba-reset" @click="resetFilters">重置</button>
        </div>

        <div v-if="error" class="empty-hint">{{ error }}</div>
        <div v-else-if="loading" class="empty-hint">加载中…</div>
        <div v-else-if="visible.length === 0" class="empty-hint">无匹配的授权 / 反馈记录</div>
        <ul v-else class="ba-list">
            <li v-for="row in visible" :key="row.ts" class="ba-card" :class="'ba-' + (resultOf(row) ?? 'unknown')">
                <div class="ba-head">
                    <span class="ba-time">{{ fmtTime(row.ts) }}</span>
                    <span class="ba-badge" :class="resultOf(row)">
                        {{ resultOf(row) === 'allowed' ? '允许' : resultOf(row) === 'denied' ? '拒绝' : resultOf(row) === 'up' ? '赞' : '踩' }}
                    </span>
                    <span class="ba-kind">{{ row.type === 'authorization' ? '授权' : '反馈' }}</span>
                </div>

                <template v-if="row.type === 'authorization'">
                    <div class="ba-line" v-if="evidenceOf(row).capability">
                        <span class="ba-label">工具</span>{{ evidenceOf(row).capability }}
                    </div>
                    <div class="ba-line ba-summary-text" v-if="evidenceOf(row).summary">
                        <span class="ba-label">摘要</span>{{ evidenceOf(row).summary }}
                    </div>
                    <div class="ba-meta">
                        <span v-if="evidenceOf(row).scope">作用域 {{ evidenceOf(row).scope }}</span>
                        <span v-if="evidenceOf(row).latencyMs">耗时 {{ fmtLatency(evidenceOf(row).latencyMs) }}</span>
                        <span v-if="evidenceOf(row).invocationId">调用 {{ evidenceOf(row).invocationId }}</span>
                    </div>
                </template>

                <template v-else>
                    <div class="ba-meta">
                        <span v-if="row.ref">被评时刻 {{ fmtTime(row.ref.ts) }}</span>
                    </div>
                </template>

                <div class="ba-meta ba-origin">
                    <span v-if="row.rootGoalId">goal {{ row.rootGoalId }}</span>
                    <span v-if="row.conversationId">会话 {{ row.conversationId }}</span>
                </div>
            </li>
        </ul>
    </div>
</template>

<style scoped>
.behavior-badge {
    margin-left: auto;
    font-size: 12px;
    color: var(--fg-tertiary);
}
.ba-summary {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 8px;
}
.ba-stat {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 8px 4px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-panel);
}
.ba-num {
    font-size: 18px;
    font-weight: 600;
}
.ba-cap {
    font-size: 11px;
    color: var(--fg-secondary);
}
.ba-filters {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
}
.ba-input {
    padding: 4px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-panel);
    color: var(--fg);
    font-size: 13px;
}
.ba-reset {
    padding: 4px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-panel);
    color: var(--fg-secondary);
    cursor: pointer;
    font-size: 13px;
}
.ba-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 0;
    margin: 0;
    list-style: none;
}
.ba-card {
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-left: 3px solid var(--border);
    border-radius: 8px;
    background: var(--bg-panel);
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
}
.ba-allowed {
    border-left-color: #2ea043;
}
.ba-denied {
    border-left-color: #d1544a;
}
.ba-up {
    border-left-color: #2ea043;
}
.ba-down {
    border-left-color: #d1544a;
}
.ba-head {
    display: flex;
    align-items: center;
    gap: 10px;
}
.ba-time {
    font-family: ui-monospace, monospace;
    font-size: 11px;
    color: var(--fg-tertiary);
}
.ba-badge {
    padding: 1px 8px;
    border-radius: 10px;
    font-size: 12px;
    font-weight: 600;
}
.ba-badge.allowed,
.ba-badge.up {
    background: rgba(46, 160, 67, 0.15);
    color: #2ea043;
}
.ba-badge.denied,
.ba-badge.down {
    background: rgba(209, 84, 74, 0.15);
    color: #d1544a;
}
.ba-kind {
    font-size: 12px;
    color: var(--fg-secondary);
}
.ba-line {
    color: var(--fg-secondary);
}
.ba-summary-text {
    color: var(--fg);
}
.ba-label {
    display: inline-block;
    min-width: 40px;
    color: var(--fg-tertiary);
    margin-right: 6px;
}
.ba-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    font-size: 12px;
    color: var(--fg-secondary);
}
.ba-origin {
    color: var(--fg-tertiary);
    font-family: ui-monospace, monospace;
}
</style>
