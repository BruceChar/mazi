<script setup>
/**
 * TopBar — application header.
 *
 * Owns only presentation and the two shell toggles; conversation/workspace
 * state stays in App.vue and is passed down as props.
 */
import LineIcon from '../assets/LineIcon.vue';

defineProps({
    /** Whether the left sidebar is currently expanded. */
    sidebarOpen: { type: Boolean, default: true },
    /** Whether the right audit panel is currently expanded. */
    rightOpen: { type: Boolean, default: false },
});
const emit = defineEmits(['toggle-sidebar', 'toggle-right']);
</script>

<template>
    <header class="topbar">
        <div class="topbar-left">
            <button
                class="icon-btn sidebar-toggle"
                title="折叠/展开侧边栏"
                @click="emit('toggle-sidebar')"
            >
                <LineIcon name="menu" />
            </button>
            <span class="brand">mazi</span>
            <span class="slogan">Be water, my friend</span>
        </div>
        <div class="topbar-right">
            <button
                class="ghost right-toggle"
                :title="rightOpen ? '收起事件栏' : '展开事件栏'"
                @click="emit('toggle-right')"
            >
                <LineIcon name="panel" />
            </button>
        </div>
    </header>
</template>
