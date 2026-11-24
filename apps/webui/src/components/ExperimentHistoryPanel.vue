<script setup>
/**
 * ExperimentHistoryPanel — AB 实验的历史记录栏（Lab › AB 实验 右侧）。
 *
 * 历史实验曾挂在左侧分类导航下面，实验一多就把导航挤满；现在独立成一栏，
 * 自带滚动并可收起（收起后只留一条窄条：图标 + 条数）。
 * 选择通过 store 的共享选中态回投给主区，点选即载入详情。
 */
import LineIcon from '../assets/LineIcon.vue';
import { armStatusLabel, experimentStatusLabel } from '../scripts/experiments.ts';

defineProps({
    experiments: { type: Array, default: () => [] },
    selectedId: { type: String, default: '' },
    collapsed: { type: Boolean, default: false },
});
const emit = defineEmits(['select', 'toggle']);

function time(value) {
    return value ? new Date(value).toLocaleString() : '-';
}
function armsSummary(item) {
    return item.arms.map((arm) => arm.label + ':' + armStatusLabel(arm.status)).join(' / ');
}
</script>

<template>
    <aside class="history-panel" :class="{ collapsed }">
        <button v-if="collapsed" class="collapsed-btn" title="展开历史实验" @click="emit('toggle')">
            <LineIcon name="chevronLeft" size="14" />
            <span class="collapsed-count">{{ experiments.length }}</span>
        </button>
        <template v-else>
            <header class="history-head">
                <span class="history-title">历史实验（{{ experiments.length }}）</span>
                <button class="history-toggle" title="收起历史实验" @click="emit('toggle')">
                    <LineIcon name="chevronRight" size="14" />
                </button>
            </header>
            <div class="history-list">
                <button
                    v-for="item in experiments"
                    :key="item.experimentId"
                    class="history-item"
                    :class="{ active: item.experimentId === selectedId }"
                    @click="emit('select', item.experimentId)"
                >
                    <span class="history-item-top">
                        <strong>{{ item.title }}</strong>
                        <span class="history-badge" :data-status="item.status">
                            {{ experimentStatusLabel(item.status) }}
                        </span>
                    </span>
                    <span class="history-meta">
                        {{ time(item.createdAt) }} · {{ armsSummary(item) }}
                        <template v-if="item.reviewCount"> · 复盘 {{ item.reviewCount }}</template>
                    </span>
                </button>
                <p v-if="!experiments.length" class="history-empty">暂无实验</p>
            </div>
        </template>
    </aside>
</template>

<style scoped>
.history-panel {
    flex: 0 0 auto;
    width: 248px;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-left: 1px solid var(--border-soft);
    transition: width 0.16s ease;
}
.history-panel.collapsed {
    width: 36px;
    align-items: center;
    justify-content: flex-start;
    padding-top: 4px;
}
.collapsed-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    width: 28px;
    padding: 6px 0;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--fg-secondary);
    cursor: pointer;
}
.collapsed-btn:hover {
    background: var(--bg-hover);
    color: var(--fg);
}
.collapsed-count {
    font-size: 10px;
    color: var(--fg-tertiary);
}
.history-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding: 2px 4px 6px 10px;
}
.history-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--fg-secondary);
}
.history-toggle {
    width: 22px;
    height: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--fg-tertiary);
    cursor: pointer;
    padding: 0;
}
.history-toggle:hover {
    background: var(--bg-hover);
    color: var(--fg);
}
.history-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0 4px 4px;
}
.history-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 8px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--fg-secondary);
    text-align: left;
    cursor: pointer;
    width: 100%;
    min-width: 0;
}
.history-item:hover,
.history-item:focus-visible {
    background: var(--bg-hover);
}
.history-item.active {
    background: var(--bg-active);
}
.history-item-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    min-width: 0;
}
.history-item-top strong {
    font-size: 12px;
    font-weight: 500;
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.history-badge {
    flex: 0 0 auto;
    font-size: 10px;
    color: var(--fg-tertiary);
}
.history-badge[data-status='running'] {
    color: var(--accent);
}
.history-badge[data-status='completed'] {
    color: var(--ok);
}
.history-badge[data-status='failed'],
.history-badge[data-status='aborted'] {
    color: var(--error);
}
.history-meta {
    font-size: 10px;
    color: var(--fg-tertiary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.history-empty {
    margin: 0;
    padding: 6px 8px;
    font-size: 11px;
    color: var(--fg-tertiary);
}
</style>
