<script setup>
import LineIcon from '../LineIcon.vue';

defineProps({
    tabs: { type: Array, required: true },
    activeTab: { type: String, default: 'general' },
});
const emit = defineEmits(['update:activeTab', 'back']);
</script>

<template>
    <div class="settings-sidebar">
        <div class="settings-nav">
            <button
                v-for="tab in tabs"
                :key="tab.id"
                class="settings-nav-item"
                :class="{ active: activeTab === tab.id }"
                @click="emit('update:activeTab', tab.id)"
            >
                <LineIcon :name="tab.icon" size="15" />
                <span>{{ tab.label }}</span>
            </button>
        </div>
        <div class="settings-back">
            <button class="settings-back-btn" @click="emit('back')">
                <LineIcon name="chevronLeft" size="15" />
                <span>Back to app</span>
            </button>
        </div>
    </div>
</template>

<style scoped>
.settings-sidebar {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
}
.settings-nav {
    flex: 1;
    padding: 12px 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow-y: auto;
}
.settings-nav-item {
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
.settings-nav-item:hover {
    background: var(--bg-hover);
    color: var(--fg);
}
.settings-nav-item.active {
    background: var(--bg-active);
    color: var(--fg);
    font-weight: 500;
}
.settings-back {
    flex: 0 0 auto;
    padding: 8px 10px;
    border-top: 1px solid var(--border-soft);
}
.settings-back-btn {
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
.settings-back-btn:hover {
    background: var(--bg-hover);
    color: var(--fg);
}
</style>
