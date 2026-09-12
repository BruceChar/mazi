<script setup>
/**
 * StoragePanel —— 右侧栏「存储」看板（docs/web/存储面板设计.md §4）。
 * 只读展示 SQLite：总览/占用条/全库搜索/逐表分页浏览。数据来自 /api/storage 只读接口。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import LineIcon from '../assets/LineIcon.vue';
import { api } from '../api.js';
import { formatBytes } from '../scripts/audit.ts';
import {
    clampPage,
    prettyCellText,
    sizeShare,
    storagePageCount,
    tableRowPreview,
    totalTableBytes,
    usageSegments,
} from '../scripts/storage.ts';

const PAGE_SIZE = 50;

const overview = ref(null);
const error = ref('');
const loading = ref(false);

const selectedTable = ref('');
const tableQuery = ref('');
const tablePage = ref(null);
const page = ref(1);
const expanded = ref(new Set());

const globalQuery = ref('');
const searchResult = ref(null);
const searching = ref(false);

const segments = computed(() => usageSegments(overview.value?.tables || []));
const tableBytesSum = computed(() => totalTableBytes(overview.value?.tables || []));
const tables = computed(() => overview.value?.tables || []);
const pageCount = computed(() =>
    storagePageCount(tablePage.value?.total ?? 0, tablePage.value?.limit ?? PAGE_SIZE),
);
const tableRows = computed(() => tablePage.value?.rows || []);

async function loadOverview() {
    loading.value = true;
    error.value = '';
    try {
        overview.value = await api('/api/storage');
    } catch (e) {
        error.value = String(e);
    } finally {
        loading.value = false;
    }
}

async function loadTable() {
    const name = selectedTable.value;
    if (!name) return;
    try {
        const offset = (page.value - 1) * PAGE_SIZE;
        const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
        const query = tableQuery.value.trim();
        if (query) params.set('q', query);
        tablePage.value = await api(`/api/storage/tables/${encodeURIComponent(name)}?${params}`);
    } catch (e) {
        error.value = String(e);
        tablePage.value = null;
    }
}

async function openTable(name, query = '') {
    selectedTable.value = name;
    tableQuery.value = query;
    page.value = 1;
    expanded.value = new Set();
    await loadTable();
}

function closeTable() {
    selectedTable.value = '';
    tablePage.value = null;
    tableQuery.value = '';
    page.value = 1;
}

function applyTableFilter() {
    page.value = 1;
    void loadTable();
}

function goPage(next) {
    page.value = clampPage(next, pageCount.value);
    void loadTable();
}

let searchTimer = null;
watch(globalQuery, () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void runSearch(), 300);
});

async function runSearch() {
    const query = globalQuery.value.trim();
    if (!query) {
        searchResult.value = null;
        return;
    }
    searching.value = true;
    try {
        searchResult.value = await api(
            `/api/storage/search?q=${encodeURIComponent(query)}&limit=5`,
        );
    } catch (e) {
        error.value = String(e);
    } finally {
        searching.value = false;
    }
}

function toggleRow(key) {
    const next = new Set(expanded.value);
    next.has(key) ? next.delete(key) : next.add(key);
    expanded.value = next;
}

onMounted(loadOverview);
onBeforeUnmount(() => {
    if (searchTimer) clearTimeout(searchTimer);
});
</script>

<template>
    <div class="drawer-body storage-body">
        <div class="storage-head">
            <span class="storage-heading">存储 · SQLite</span>
            <button class="ev-toggle" :disabled="loading" @click="loadOverview">
                {{ loading ? '刷新中…' : '刷新' }}
            </button>
        </div>
        <div v-if="overview" class="storage-path" :title="overview.path">{{ overview.path }}</div>

        <div v-if="error" class="empty-hint">{{ error }}</div>

        <template v-if="overview && !overview.exists">
            <div class="empty-hint">数据库尚未创建（首次运行后出现）</div>
        </template>

        <template v-else-if="overview">
            <!-- 使用量总览 -->
            <section class="storage-section">
                <div class="storage-metrics">
                    <div class="storage-metric">
                        <span class="storage-metric-num">{{ formatBytes(overview.totals.dataBytes) }}</span>
                        <span class="storage-metric-cap">文件大小</span>
                    </div>
                    <div class="storage-metric">
                        <span class="storage-metric-num">{{ overview.totals.tables }}</span>
                        <span class="storage-metric-cap">张表</span>
                    </div>
                    <div class="storage-metric">
                        <span class="storage-metric-num">{{ overview.totals.rows }}</span>
                        <span class="storage-metric-cap">行数据</span>
                    </div>
                    <div class="storage-metric">
                        <span class="storage-metric-num">{{ overview.pageCount }}</span>
                        <span class="storage-metric-cap">{{ overview.pageSize }}B / 页</span>
                    </div>
                </div>
                <div v-if="segments.length" class="storage-usage">
                    <div class="storage-bar">
                        <span
                            v-for="seg in segments"
                            :key="seg.key"
                            class="storage-bar-seg"
                            :style="{ width: seg.share * 100 + '%', background: 'var(' + seg.colorVar + ')' }"
                            :title="seg.label + ' · ' + formatBytes(seg.bytes)"
                        ></span>
                    </div>
                    <div class="storage-legend">
                        <span v-for="seg in segments" :key="seg.key" class="storage-legend-item">
                            <span class="storage-dot" :style="{ background: 'var(' + seg.colorVar + ')' }"></span>
                            <span class="storage-legend-label">{{ seg.label }}</span>
                            <span class="storage-legend-share">{{ Math.round(seg.share * 100) }}%</span>
                        </span>
                    </div>
                    <div v-if="overview.sizeSource === 'unavailable'" class="storage-note">
                        dbstat 不可用，无法统计占用
                    </div>
                </div>
                <div v-else class="storage-note">暂无占用数据</div>
            </section>

            <!-- 全库搜索 -->
            <section class="storage-section">
                <div class="storage-search">
                    <LineIcon name="search" size="13" />
                    <input
                        v-model="globalQuery"
                        class="storage-input"
                        type="search"
                        placeholder="全库搜索（所有表文本列）"
                    />
                    <span v-if="searching" class="storage-note">搜索中…</span>
                </div>
                <div v-if="searchResult" class="storage-search-result">
                    <div v-if="!searchResult.total" class="empty-hint">无匹配数据</div>
                    <template v-else>
                        <div class="storage-note">
                            {{ searchResult.total }} 条命中 · {{ searchResult.tables.length }} 张表
                        </div>
                        <div v-for="hit in searchResult.tables" :key="hit.table" class="storage-hit">
                            <button class="storage-hit-head" @click="openTable(hit.table, globalQuery.trim())">
                                <span class="storage-table-name">{{ hit.table }}</span>
                                <span class="storage-hit-count">{{ hit.matches }} 条</span>
                            </button>
                            <button
                                v-for="(row, idx) in hit.rows"
                                :key="idx"
                                class="storage-hit-row"
                                @click="openTable(hit.table, globalQuery.trim())"
                            >
                                {{ tableRowPreview(row, 120) }}
                            </button>
                        </div>
                    </template>
                </div>
            </section>

            <!-- 表清单 -->
            <section v-if="!selectedTable" class="storage-section">
                <div class="storage-section-title">数据表（{{ tables.length }}）</div>
                <button
                    v-for="table in tables"
                    :key="table.name"
                    class="storage-table-row"
                    @click="openTable(table.name)"
                >
                    <span class="storage-table-name">{{ table.name }}</span>
                    <span class="storage-table-rows">{{ table.rows }} 行</span>
                    <span class="storage-table-size">{{ table.bytes == null ? '—' : formatBytes(table.bytes) }}</span>
                    <span class="storage-table-share">{{ Math.round(sizeShare(table.bytes, tableBytesSum) * 100) }}%</span>
                    <span class="storage-mini">
                        <span
                            class="storage-mini-fill"
                            :style="{ width: Math.max(2, sizeShare(table.bytes, tableBytesSum) * 100) + '%' }"
                        ></span>
                    </span>
                </button>
                <div v-if="!tables.length" class="empty-hint">暂无数据表</div>
            </section>

            <!-- 表视图 -->
            <section v-else class="storage-section">
                <div class="storage-crumb">
                    <button class="storage-back" @click="closeTable">← 全部表</button>
                    <span class="storage-crumb-name">{{ selectedTable }}</span>
                    <span class="storage-table-rows">{{ tablePage?.total ?? 0 }} 行</span>
                </div>
                <div class="storage-search">
                    <LineIcon name="search" size="13" />
                    <input
                        v-model="tableQuery"
                        class="storage-input"
                        type="search"
                        placeholder="表内过滤…"
                        @keyup.enter="applyTableFilter"
                    />
                    <button class="ev-toggle" @click="applyTableFilter">过滤</button>
                </div>
                <div v-if="tablePage" class="storage-table-wrap">
                    <table class="storage-grid">
                        <thead>
                            <tr>
                                <th v-for="col in tablePage.columns" :key="col">{{ col }}</th>
                            </tr>
                        </thead>
                        <tbody>
                            <template v-for="(row, idx) in tableRows" :key="idx">
                                <tr class="storage-data-row" @click="toggleRow(idx)">
                                    <td
                                        v-for="col in tablePage.columns"
                                        :key="col"
                                        :title="tableRowPreview(row[col], 200)"
                                    >
                                        {{ tableRowPreview(row[col]) }}
                                    </td>
                                </tr>
                                <tr v-if="expanded.has(idx)" class="storage-expand-row">
                                    <td :colspan="tablePage.columns.length">
                                        <pre
                                            v-for="col in tablePage.columns"
                                            :key="col"
                                            class="storage-cell-full"
                                        ><b>{{ col }}</b>{{ prettyCellText(row[col]) }}</pre>
                                    </td>
                                </tr>
                            </template>
                        </tbody>
                    </table>
                    <div v-if="!tableRows.length" class="empty-hint">无数据</div>
                </div>
                <div v-if="pageCount > 1" class="storage-pager">
                    <button class="ev-toggle" :disabled="page <= 1" @click="goPage(page - 1)">上一页</button>
                    <span class="storage-page-info">{{ page }} / {{ pageCount }}</span>
                    <button class="ev-toggle" :disabled="page >= pageCount" @click="goPage(page + 1)">下一页</button>
                </div>
            </section>
        </template>
    </div>
</template>

<style scoped>
.storage-body {
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.storage-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}
.storage-heading {
    font-size: 12px;
    font-weight: 600;
    color: var(--fg);
}
.storage-head .ev-toggle {
    margin-left: 0;
}
.storage-path {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 10px;
    color: var(--fg-tertiary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.storage-section {
    border-top: 1px solid var(--border-soft);
    padding-top: 8px;
}
.storage-section-title {
    font-size: 11px;
    font-weight: 600;
    color: var(--fg-secondary);
    margin-bottom: 6px;
}
.storage-metrics {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 6px;
}
.storage-metric {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 7px 6px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
    text-align: center;
    min-width: 0;
}
.storage-metric-num {
    font-size: 13px;
    font-weight: 600;
    color: var(--fg);
}
.storage-metric-cap {
    font-size: 10px;
    color: var(--fg-tertiary);
}
.storage-usage {
    margin-top: 8px;
}
.storage-bar {
    display: flex;
    height: 10px;
    border-radius: 5px;
    overflow: hidden;
    background: var(--border-soft);
}
.storage-bar-seg {
    height: 100%;
}
.storage-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 10px;
    margin-top: 6px;
}
.storage-legend-item {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    color: var(--fg-secondary);
}
.storage-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
}
.storage-legend-label {
    max-width: 110px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.storage-legend-share {
    color: var(--fg-tertiary);
    font-variant-numeric: tabular-nums;
}
.storage-note {
    font-size: 10px;
    color: var(--fg-tertiary);
}
.storage-search {
    display: flex;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 3px 7px;
    background: var(--bg-panel);
    color: var(--fg-tertiary);
}
.storage-input {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    color: var(--fg);
    font-size: 11px;
    outline: none;
}
.storage-search .ev-toggle {
    margin-left: 0;
}
.storage-search-result {
    margin-top: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.storage-hit {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
}
.storage-hit-head {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border: none;
    background: var(--bg-panel);
    color: var(--fg);
    padding: 5px 8px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
}
.storage-hit-count {
    font-weight: 400;
    color: var(--fg-tertiary);
}
.storage-hit-row {
    display: block;
    width: 100%;
    text-align: left;
    border: none;
    border-top: 1px solid var(--border-soft);
    background: transparent;
    color: var(--fg-secondary);
    padding: 4px 8px;
    font-size: 10px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.storage-hit-row:hover,
.storage-table-row:hover,
.storage-data-row:hover {
    background: var(--accent-soft);
}
.storage-table-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto auto;
    align-items: center;
    gap: 6px;
    width: 100%;
    border: none;
    border-bottom: 1px solid var(--border-soft);
    background: transparent;
    color: var(--fg);
    padding: 6px 4px;
    font-size: 11px;
    cursor: pointer;
    text-align: left;
}
.storage-table-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.storage-table-rows,
.storage-table-size,
.storage-table-share {
    color: var(--fg-tertiary);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
}
.storage-mini {
    grid-column: 1 / -1;
    height: 3px;
    border-radius: 2px;
    background: var(--border-soft);
    overflow: hidden;
}
.storage-mini-fill {
    display: block;
    height: 100%;
    background: var(--accent);
}
.storage-crumb {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
}
.storage-back {
    border: none;
    background: transparent;
    color: var(--accent);
    font-size: 11px;
    cursor: pointer;
    padding: 0;
}
.storage-crumb-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11px;
    font-weight: 600;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.storage-table-wrap {
    margin-top: 8px;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
}
.storage-grid {
    border-collapse: collapse;
    width: 100%;
    font-size: 10px;
}
.storage-grid th,
.storage-grid td {
    border-bottom: 1px solid var(--border-soft);
    padding: 4px 6px;
    text-align: left;
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.storage-grid th {
    position: sticky;
    top: 0;
    background: var(--bg-panel);
    color: var(--fg-secondary);
    font-weight: 600;
    z-index: 1;
}
.storage-data-row {
    cursor: pointer;
    color: var(--fg-secondary);
}
.storage-expand-row td {
    max-width: none;
    white-space: normal;
    background: var(--bg);
}
.storage-cell-full {
    margin: 0 0 6px;
    padding: 4px 6px;
    background: var(--bg-panel);
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
    font-size: 10px;
    color: var(--fg-secondary);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 220px;
    overflow: auto;
}
.storage-cell-full b {
    display: block;
    color: var(--fg-tertiary);
    margin-bottom: 2px;
    font-weight: 500;
}
.storage-pager {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    margin-top: 8px;
}
.storage-pager .ev-toggle {
    margin-left: 0;
}
.storage-page-info {
    font-size: 11px;
    color: var(--fg-secondary);
    font-variant-numeric: tabular-nums;
}
</style>
