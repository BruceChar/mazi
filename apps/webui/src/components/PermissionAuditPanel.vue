<script setup>
/**
 * PermissionAuditPanel —— 右侧栏「权限」审计面板。
 *
 * 展示当前 run（rootGoalId）的全部权限事件：用户批准 / Agent 自动放行 /
 * 策略拒绝 / 待审批 / 取消 / 撤销 / 记忆命中，保留角色、结果、工具、决策依据、
 * 作用域与上下文锚点。支持角色 / 结果 / 工具 / 关键词 / 时间范围筛选。
 * 数据来自 GET /api/permissions/audit，事件只追加、只读。
 */
import { computed, ref, watch } from 'vue';
import { api } from '../api.js';
import {
    ACTOR_OPTIONS,
    RESULT_OPTIONS,
    actorLabel,
    applyFilters,
    resultLabel,
    summarize,
} from '../scripts/permission-audit.ts';

const props = defineProps({
    rootGoalId: { type: String, default: '' },
});

const records = ref([]);
const loading = ref(false);
const error = ref('');

const filters = ref({
    actor: '',
    result: '',
    tool: '',
    keyword: '',
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

const filtered = computed(() =>
    applyFilters(records.value, {
        actor: filters.value.actor || undefined,
        result: filters.value.result || undefined,
        tool: filters.value.tool || undefined,
        keyword: filters.value.keyword || undefined,
        from: dayStart(filters.value.from),
        to: dayEnd(filters.value.to),
    }),
);

const summary = computed(() => summarize(filtered.value));

const toolOptions = computed(() => {
    const seen = new Set();
    for (const record of records.value) {
        if (record.tool) seen.add(record.tool);
    }
    return [...seen].sort();
});

const visible = computed(() => [...filtered.value].sort((a, b) => b.at - a.at));

async function reload() {
    loading.value = true;
    error.value = '';
    try {
        const params = new URLSearchParams();
        // 无 rootGoalId 时后端全量回放（跨全部历史 run，用户中心全局审计）。
        if (props.rootGoalId) params.set('rootGoalId', props.rootGoalId);
        const data = await api(`/api/permissions/audit?${params}`);
        records.value = data.records ?? [];
    } catch (e) {
        error.value = String(e);
        records.value = [];
    } finally {
        loading.value = false;
    }
}

function resetFilters() {
    filters.value = { actor: '', result: '', tool: '', keyword: '', from: '', to: '' };
}

function fmtTime(at) {
    return new Date(at).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
}

function resultClass(result) {
    if (result === 'approved') return 'ok';
    if (result === 'denied' || result === 'revoked') return 'error';
    if (result === 'pending') return 'warn';
    return 'info';
}

watch(() => props.rootGoalId, reload, { immediate: true });
</script>

<template>
    <div class="drawer-body perm-body">
        <div class="perm-head">
            <span class="perm-heading">权限审计</span>
            <button class="ev-toggle" :disabled="loading" @click="reload">
                {{ loading ? '刷新中…' : '刷新' }}
            </button>
        </div>

        <div v-if="error" class="empty-hint">{{ error }}</div>

        <template v-else>
            <div class="perm-summary">
                <div class="perm-stat">
                    <span class="perm-stat-num">{{ summary.total }}</span>
                    <span class="perm-stat-cap">事件</span>
                </div>
                <div class="perm-stat">
                    <span class="perm-stat-num">{{ summary.byActor.user }}</span>
                    <span class="perm-stat-cap">用户批准</span>
                </div>
                <div class="perm-stat">
                    <span class="perm-stat-num">{{ summary.byResult.auto }}</span>
                    <span class="perm-stat-cap">Agent 放行</span>
                </div>
                <div class="perm-stat">
                    <span class="perm-stat-num">{{ summary.byResult.denied }}</span>
                    <span class="perm-stat-cap">拒绝</span>
                </div>
                <div class="perm-stat">
                    <span class="perm-stat-num">{{ summary.byResult.pending }}</span>
                    <span class="perm-stat-cap">待审批</span>
                </div>
            </div>

            <div class="perm-filters">
                <select v-model="filters.actor" class="perm-input" title="按角色筛选">
                    <option value="">全部角色</option>
                    <option v-for="opt in ACTOR_OPTIONS" :key="opt.value" :value="opt.value">
                        {{ opt.label }}
                    </option>
                </select>
                <select v-model="filters.result" class="perm-input" title="按结果筛选">
                    <option value="">全部结果</option>
                    <option v-for="opt in RESULT_OPTIONS" :key="opt.value" :value="opt.value">
                        {{ opt.label }}
                    </option>
                </select>
                <select v-model="filters.tool" class="perm-input" title="按工具筛选">
                    <option value="">全部工具</option>
                    <option v-for="tool in toolOptions" :key="tool" :value="tool">{{ tool }}</option>
                </select>
                <input
                    v-model="filters.keyword"
                    class="perm-input"
                    type="search"
                    placeholder="关键词（依据/工具）"
                />
                <input v-model="filters.from" class="perm-input" type="date" title="起始日期" />
                <input v-model="filters.to" class="perm-input" type="date" title="结束日期" />
                <button class="ev-toggle" @click="resetFilters">重置</button>
            </div>

            <div v-if="visible.length === 0" class="empty-hint">无匹配的权限记录</div>
            <ul v-else class="perm-list">
                <li v-for="record in visible" :key="record.id" class="perm-item" :class="resultClass(record.result)">
                    <div class="perm-item-row">
                        <span class="perm-time">{{ fmtTime(record.at) }}</span>
                        <span class="perm-badge actor">{{ actorLabel(record.actor) }}</span>
                        <span class="perm-badge" :class="resultClass(record.result)">
                            {{ resultLabel(record.result) }}
                        </span>
                        <span v-if="record.tool" class="perm-tool">{{ record.tool }}</span>
                    </div>
                    <div class="perm-basis" :title="record.basis">{{ record.basis || record.kind }}</div>
                    <div class="perm-meta">
                        <span v-if="record.scope">作用域 {{ record.scope }}</span>
                        <span v-if="record.stage">阶段 {{ record.stage }}</span>
                        <span v-if="record.effectClass">类别 {{ record.effectClass }}</span>
                        <span v-if="record.goalId">goal {{ record.goalId }}</span>
                        <span v-if="record.stepId">step {{ record.stepId }}</span>
                    </div>
                </li>
            </ul>
        </template>
    </div>
</template>

<style scoped>
.perm-body {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px;
    overflow-y: auto;
}
.perm-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
}
.perm-heading {
    font-weight: 600;
    font-size: 13px;
}
.perm-summary {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 8px;
}
.perm-stat {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 8px 4px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-panel);
}
.perm-stat-num {
    font-size: 18px;
    font-weight: 600;
}
.perm-stat-cap {
    font-size: 11px;
    color: var(--fg-secondary);
}
.perm-filters {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}
.perm-input {
    flex: 1 1 40%;
    min-width: 90px;
    padding: 5px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-panel);
    color: var(--fg);
    font-size: 12px;
}
.perm-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
}
.perm-item {
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-left: 3px solid var(--border);
    border-radius: 8px;
    background: var(--bg-panel);
}
.perm-item.ok {
    border-left-color: var(--ok);
}
.perm-item.error {
    border-left-color: var(--error);
}
.perm-item.warn {
    border-left-color: var(--warn);
}
.perm-item.info {
    border-left-color: var(--tool);
}
.perm-item-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}
.perm-time {
    font-size: 11px;
    color: var(--fg-secondary);
    font-variant-numeric: tabular-nums;
}
.perm-badge {
    padding: 1px 7px;
    border-radius: 999px;
    font-size: 11px;
    line-height: 1.5;
}
.perm-badge.actor {
    background: var(--accent-soft);
    color: var(--accent-text);
}
.perm-badge.ok {
    background: var(--ok-soft);
    color: var(--ok);
}
.perm-badge.error {
    background: var(--error-soft);
    color: var(--error);
}
.perm-badge.warn {
    background: var(--warn-soft);
    color: var(--warn);
}
.perm-badge.info {
    background: var(--tool-soft);
    color: var(--tool);
}
.perm-tool {
    font-family: ui-monospace, monospace;
    font-size: 11px;
    color: var(--fg);
}
.perm-basis {
    margin-top: 4px;
    font-size: 12px;
    color: var(--fg);
    word-break: break-word;
}
.perm-meta {
    margin-top: 4px;
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    font-size: 11px;
    color: var(--fg-tertiary);
}
</style>
