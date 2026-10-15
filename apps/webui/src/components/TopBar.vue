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
    /** 当前会话名称（贴 topbar 下边框、从侧栏宽度处开始；超长截断）。 */
    conversationTitle: { type: String, default: '' },
    /** 当前会话工作区（项目工作空间 / 随心聊默认工作区）。 */
    workspace: { type: String, default: '' },
    /** 当前是否在用户中心页（人形图标高亮）。 */
    userCenterOpen: { type: Boolean, default: false },
});
const emit = defineEmits(['toggle-sidebar', 'toggle-right', 'open-user-center']);
</script>

<template>
    <header class="topbar" :class="{ 'sidebar-collapsed': !sidebarOpen }">
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
            <button
                class="icon-btn account-btn"
                :class="{ on: userCenterOpen }"
                title="用户中心（画像 / 问题 / 行为链 / 账本 / 用户设置）"
                @click="emit('open-user-center')"
            >
                <LineIcon name="user" />
            </button>
        </div>
        <!-- 会话名称 + 工作区：从侧栏宽度处开始、贴着 topbar 下边框 -->
        <div v-if="conversationTitle" class="topbar-conv-wrap">
            <span class="topbar-conv" :title="conversationTitle">{{ conversationTitle }}</span>
            <span v-if="workspace" class="topbar-ws" :title="workspace">{{ workspace }}</span>
        </div>
    </header>
</template>

<style scoped>
.account-btn.on {
    color: var(--accent);
    background: var(--bg-hover);
}
</style>

