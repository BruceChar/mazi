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
    /** 当前会话名称（常驻顶部栏、品牌右侧）。 */
    conversationTitle: { type: String, default: '' },
    /** 当前会话工作区（项目工作区 / 随心聊默认工作区）。 */
    workspace: { type: String, default: '' },
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
            <template v-if="conversationTitle">
                <span class="topbar-divider"></span>
                <span class="topbar-conv" :title="conversationTitle">{{ conversationTitle }}</span>
                <span v-if="workspace" class="topbar-ws" :title="workspace">{{ workspace }}</span>
            </template>
        </div>
        <div class="topbar-right">
            <span class="slogan">Be water, my friend</span>
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
