<script setup>
/**
 * LedgerPage — 失败分类账（个人中心 → 账本）。
 *
 * 数据来自 GET /api/ledger：Task 终态失败事实（aborted 除外），按 createdAt 倒序。
 */
import { onMounted, ref } from 'vue';
import LineIcon from '../assets/LineIcon.vue';
import { fetchLedger } from '../scripts/store.ts';

const emit = defineEmits(['close']);

const entries = ref([]);
const loading = ref(true);
const error = ref('');

function shortId(id) {
    return id ? id.slice(0, 8) : '-';
}
function timeOf(ts) {
    return new Date(ts).toLocaleString();
}

onMounted(async () => {
    try {
        entries.value = await fetchLedger({ limit: 200 });
    } catch (e) {
        error.value = String(e);
    } finally {
        loading.value = false;
    }
});
</script>

<template>
    <div class="page-card">
        <div class="page-heading">
            <button class="icon-btn back-btn" title="返回会话" @click="emit('close')">
                <LineIcon name="chevronRight" size="16" />
            </button>
            <h1>失败分类账</h1>
            <span class="ledger-badge">{{ entries.length }} 条</span>
        </div>
        <div v-if="error" class="empty-hint">{{ error }}</div>
        <div v-else-if="loading" class="empty-hint">加载中…</div>
        <div v-else-if="entries.length" class="ledger-list">
            <div v-for="entry in entries" :key="entry.failureId" class="ledger-row">
                <span class="ledger-kind">{{ entry.kind }}</span>
                <span class="ledger-summary" :title="entry.summary">{{ entry.summary || '-' }}</span>
                <span class="ledger-session" :title="entry.sessionId">{{ shortId(entry.sessionId) }}</span>
                <span class="ledger-time">{{ timeOf(entry.createdAt) }}</span>
            </div>
        </div>
        <div v-else class="empty-hint">暂无失败记录</div>
    </div>
</template>

<style scoped>
.ledger-badge {
    margin-left: auto;
    font-size: 12px;
    color: var(--fg-tertiary);
}
.ledger-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
}
.ledger-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    border-left: 2px solid var(--warn);
    border-radius: var(--radius-sm);
    font-size: 13px;
    color: var(--fg-secondary);
}
.ledger-kind {
    flex-shrink: 0;
    width: 92px;
    font-size: 12px;
    font-weight: 600;
    color: var(--fg);
}
.ledger-summary {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.ledger-session,
.ledger-time {
    flex-shrink: 0;
    font-family: ui-monospace, monospace;
    font-size: 11px;
    color: var(--fg-tertiary);
}
</style>
