<script setup>
/**
 * LedgerPage — 花费账本（个人中心 → 账本）。
 *
 * 数据来自 GET /api/catalog/usage：每轮 LLM 调用落地的 UsageRecord（成本凭证）。
 * 过滤 provider / model / 日期，展示**小时粒度**聚合；任务失败账本在右侧栏「日志」。
 */
import { groupUsageByHour, sumUsage } from '@mazi/libs';
import { computed, onMounted, ref } from 'vue';
import LineIcon from '../assets/LineIcon.vue';
import { cfg, fetchUsageRecords } from '../scripts/store.ts';

const emit = defineEmits(['close']);

const records = ref([]);
const loading = ref(true);
const error = ref('');
const filters = ref({ providerId: '', modelId: '', from: '', to: '' });

const providerOptions = computed(() => cfg.value?.providers ?? []);
const modelOptions = computed(() => {
    const provider = providerOptions.value.find((item) => item.id === filters.value.providerId);
    const list = provider ? provider.models : providerOptions.value.flatMap((item) => item.models);
    return list ?? [];
});

const buckets = computed(() => groupUsageByHour(records.value));
const totals = computed(() => sumUsage(records.value));

function dayStart(value) {
    if (!value) return undefined;
    return new Date(value + 'T00:00:00').getTime();
}
function dayEnd(value) {
    if (!value) return undefined;
    const date = new Date(value + 'T00:00:00');
    date.setDate(date.getDate() + 1);
    return date.getTime();
}
function fmtCost(value, currency) {
    const symbol = currency === 'CNY' ? '¥' : '$';
    return symbol + Number(value ?? 0).toFixed(6);
}
function fmtTokens(value) {
    const n = Number(value ?? 0);
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
}
function currentFilter() {
    return {
        ...(filters.value.providerId ? { providerId: filters.value.providerId } : {}),
        ...(filters.value.modelId ? { modelId: filters.value.modelId } : {}),
        ...(dayStart(filters.value.from) !== undefined ? { from: dayStart(filters.value.from) } : {}),
        ...(dayEnd(filters.value.to) !== undefined ? { to: dayEnd(filters.value.to) } : {}),
    };
}

async function reload() {
    loading.value = true;
    error.value = '';
    try {
        records.value = await fetchUsageRecords(currentFilter());
    } catch (e) {
        error.value = String(e);
    } finally {
        loading.value = false;
    }
}

function resetFilters() {
    filters.value = { providerId: '', modelId: '', from: '', to: '' };
    void reload();
}

onMounted(reload);
</script>

<template>
    <div class="page-card">
        <div class="page-heading">
            <button class="icon-btn back-btn" title="返回会话" @click="emit('close')">
                <LineIcon name="chevronRight" size="16" />
            </button>
            <h1>花费账本</h1>
            <span class="ledger-badge">{{ totals.calls }} 次调用 · {{ fmtCost(totals.cost, totals.currency) }}</span>
        </div>

        <div class="cost-filters">
            <select v-model="filters.providerId" @change="reload">
                <option value="">全部渠道/厂商</option>
                <option v-for="provider in providerOptions" :key="provider.id" :value="provider.id">
                    {{ provider.vendor || provider.id }}
                </option>
            </select>
            <select v-model="filters.modelId" @change="reload">
                <option value="">全部模型</option>
                <option v-for="model in modelOptions" :key="model.id" :value="model.id">
                    {{ model.name || model.id }}
                </option>
            </select>
            <input v-model="filters.from" type="date" title="起始日期" @change="reload" />
            <input v-model="filters.to" type="date" title="结束日期" @change="reload" />
            <button class="setting-sync" @click="reload">查询</button>
            <button class="setting-sync" @click="resetFilters">重置</button>
        </div>

        <div v-if="error" class="empty-hint">{{ error }}</div>
        <div v-else-if="loading" class="empty-hint">加载中…</div>
        <div v-else-if="buckets.length" class="cost-table">
            <div class="cost-row cost-head">
                <span>时间（小时）</span>
                <span>调用</span>
                <span>花费</span>
                <span>in / out</span>
            </div>
            <div v-for="bucket in buckets" :key="bucket.hourStart" class="cost-row">
                <span class="cost-hour">{{ bucket.label }}</span>
                <span>{{ bucket.calls }}</span>
                <span class="cost-amount">{{ fmtCost(bucket.cost, bucket.currency) }}</span>
                <span class="cost-tokens">
                    {{ fmtTokens(bucket.inputTokens) }} / {{ fmtTokens(bucket.outputTokens) }}
                </span>
            </div>
        </div>
        <div v-else class="empty-hint">
            暂无花费记录（成功调用模型后产生）；任务执行失败记录见右侧栏「日志」。
        </div>
    </div>
</template>

<style scoped>
.ledger-badge {
    margin-left: auto;
    font-size: 12px;
    color: var(--fg-tertiary);
    font-variant-numeric: tabular-nums;
}
.cost-filters {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 14px;
}
.cost-filters select,
.cost-filters input {
    padding: 5px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-panel);
    color: var(--fg);
    font-size: 13px;
}
.cost-table {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border-soft);
    border-radius: 8px;
    overflow: hidden;
}
.cost-row {
    display: grid;
    grid-template-columns: 1fr 60px 120px 1fr;
    gap: 10px;
    padding: 7px 12px;
    font-size: 13px;
    color: var(--fg-secondary);
    border-bottom: 1px solid var(--border-soft);
    font-variant-numeric: tabular-nums;
}
.cost-row:last-child {
    border-bottom: none;
}
.cost-head {
    font-weight: 600;
    color: var(--fg);
    background: var(--bg-hover);
}
.cost-hour {
    font-family: ui-monospace, monospace;
    color: var(--fg);
}
.cost-amount {
    color: var(--accent);
    font-weight: 600;
}
.cost-tokens {
    text-align: right;
    font-family: ui-monospace, monospace;
    font-size: 12px;
}
</style>
