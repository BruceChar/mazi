<script setup>
import LineIcon from '../assets/LineIcon.vue';
import { armStatusLabel, experimentStatusLabel } from '../scripts/experiments.ts';
import { LAB_TABS } from '../scripts/lab-tabs.ts';

defineProps({
    activeTab: { type: String, default: 'ab' },
    experiments: { type: Array, default: () => [] },
    selectedId: { type: String, default: '' },
});
const emit = defineEmits(['update:activeTab', 'select-experiment', 'back']);

function time(value) {
    return value ? new Date(value).toLocaleString() : '-';
}
</script>

<template>
    <div class="lab-sidebar">
        <nav class="lab-nav" aria-label="Lab 分类">
            <template v-for="tab in LAB_TABS" :key="tab.id">
                <button
                    class="lab-nav-item"
                    :class="{ active: activeTab === tab.id }"
                    @click="emit('update:activeTab', tab.id)"
                >
                    <LineIcon :name="tab.icon" size="15" />
                    <span>{{ tab.label }}</span>
                </button>
                <!-- 历史实验挂在 AB 实验下面：不再占用 Lab 主窗口的一整栏 -->
                <div v-if="tab.id === 'ab' && activeTab === 'ab'" class="lab-history">
                    <div class="lab-history-head">历史实验（{{ experiments.length }}）</div>
                    <button
                        v-for="item in experiments"
                        :key="item.experimentId"
                        class="lab-history-item"
                        :class="{ active: item.experimentId === selectedId }"
                        @click="emit('select-experiment', item.experimentId)"
                    >
                        <span class="lab-history-top">
                            <strong>{{ item.title }}</strong>
                            <span class="lab-history-badge" :data-status="item.status">
                                {{ experimentStatusLabel(item.status) }}
                            </span>
                        </span>
                        <span class="lab-history-meta">
                            {{ time(item.createdAt) }} ·
                            {{ item.arms.map((arm) => arm.label + ':' + armStatusLabel(arm.status)).join(' / ') }}
                            <template v-if="item.reviewCount"> · 复盘 {{ item.reviewCount }}</template>
                        </span>
                    </button>
                    <p v-if="!experiments.length" class="lab-history-empty">暂无实验</p>
                </div>
            </template>
        </nav>
        <div class="lab-back">
            <button class="lab-back-btn" @click="emit('back')">
                <LineIcon name="chevronLeft" size="15" />
                <span>返回主菜单</span>
            </button>
        </div>
    </div>
</template>

<style scoped>
.lab-sidebar {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
}
.lab-nav {
    flex: 1;
    min-height: 0;
    padding: 12px 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow-y: auto;
}
.lab-nav-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border: none;
    background: transparent;
    color: var(--fg-secondary);
    font-size: 13px;
    border-radius: 6px;
    cursor: pointer;
    text-align: left;
    width: 100%;
}
.lab-nav-item:hover,
.lab-nav-item:focus-visible {
    background: var(--bg-hover);
    color: var(--fg);
}
.lab-nav-item.active {
    background: var(--bg-active);
    color: var(--fg);
    font-weight: 500;
}
.lab-history {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 2px 0 6px;
    padding-left: 8px;
    border-left: 1px solid var(--border-soft);
}
.lab-history-head {
    padding: 6px 8px 2px;
    font-size: 11px;
    color: var(--fg-tertiary);
}
.lab-history-item {
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
.lab-history-item:hover,
.lab-history-item:focus-visible {
    background: var(--bg-hover);
}
.lab-history-item.active {
    background: var(--bg-active);
}
.lab-history-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    min-width: 0;
}
.lab-history-top strong {
    font-size: 12px;
    font-weight: 500;
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.lab-history-badge {
    flex: 0 0 auto;
    font-size: 10px;
    color: var(--fg-tertiary);
}
.lab-history-badge[data-status='running'] {
    color: var(--accent);
}
.lab-history-badge[data-status='completed'] {
    color: var(--ok);
}
.lab-history-badge[data-status='failed'],
.lab-history-badge[data-status='aborted'] {
    color: var(--error);
}
.lab-history-meta {
    font-size: 10px;
    color: var(--fg-tertiary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.lab-history-empty {
    margin: 0;
    padding: 4px 8px;
    font-size: 11px;
    color: var(--fg-tertiary);
}
.lab-back {
    flex: 0 0 auto;
    padding: 8px 10px;
    border-top: 1px solid var(--border-soft);
}
.lab-back-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border: none;
    background: transparent;
    color: var(--fg-secondary);
    font-size: 13px;
    border-radius: 6px;
    cursor: pointer;
    width: 100%;
}
.lab-back-btn:hover {
    background: var(--bg-hover);
    color: var(--fg);
}
</style>
