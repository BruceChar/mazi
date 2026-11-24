<script setup>
/**
 * LabSidebar — Lab 全屏工作区的左侧分类导航。
 *
 * 只承载分类导航与返回入口，与设置页同构；AB 实验的历史列表不再挂在
 * 导航下面（实验多了会把分类挤满），改由主区右侧的可收起历史栏承载。
 */
import LineIcon from '../assets/LineIcon.vue';
import { LAB_TABS } from '../scripts/lab-tabs.ts';

defineProps({
    activeTab: { type: String, default: 'ab' },
});
const emit = defineEmits(['update:activeTab', 'back']);
</script>

<template>
    <div class="lab-sidebar">
        <nav class="lab-nav" aria-label="Lab 分类">
            <button
                v-for="tab in LAB_TABS"
                :key="tab.id"
                class="lab-nav-item"
                :class="{ active: activeTab === tab.id }"
                @click="emit('update:activeTab', tab.id)"
            >
                <LineIcon :name="tab.icon" size="15" />
                <span>{{ tab.label }}</span>
            </button>
        </nav>
        <div class="lab-back">
            <button class="lab-back-btn" @click="emit('back')">
                <LineIcon name="chevronLeft" size="15" />
                <span>Back to app</span>
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
/* 窄屏抽屉：压缩内边距，保证分类一屏可见 */
@media (max-width: 720px) {
    .lab-nav {
        padding: 8px 6px;
    }
    .lab-nav-item {
        padding: 9px 10px;
        font-size: 12px;
    }
}
</style>
