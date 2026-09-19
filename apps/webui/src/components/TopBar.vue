<script setup>
/**
 * TopBar — application header.
 *
 * Owns only presentation and the two shell toggles; conversation/workspace
 * state stays in App.vue and is passed down as props.
 */
import LineIcon from '../assets/LineIcon.vue';
import { ACCOUNT_MENU } from '../scripts/account.ts';

defineProps({
    /** Whether the left sidebar is currently expanded. */
    sidebarOpen: { type: Boolean, default: true },
    /** Whether the right audit panel is currently expanded. */
    rightOpen: { type: Boolean, default: false },
    /** 当前会话名称（贴 topbar 下边框、从侧栏宽度处开始；超长截断）。 */
    conversationTitle: { type: String, default: '' },
    /** 当前会话工作区（项目工作空间 / 随心聊默认工作区）。 */
    workspace: { type: String, default: '' },
    /** 右上角个人中心下拉是否展开。 */
    accountOpen: { type: Boolean, default: false },
});
const emit = defineEmits(['toggle-sidebar', 'toggle-right', 'toggle-account', 'account-item']);
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
            <div class="account-wrap">
                <button
                    class="icon-btn account-btn"
                    :class="{ on: accountOpen }"
                    title="个人中心"
                    @click.stop="emit('toggle-account')"
                >
                    <LineIcon name="user" />
                </button>
                <div v-if="accountOpen" class="account-menu" @click.stop>
                    <button
                        v-for="item in ACCOUNT_MENU"
                        :key="item.id"
                        class="account-item"
                        @click="emit('account-item', item.id)"
                    >
                        <LineIcon :name="item.icon" size="14" />
                        <span>{{ item.label }}</span>
                    </button>
                </div>
            </div>
        </div>
        <!-- 会话名称 + 工作区：从侧栏宽度处开始、贴着 topbar 下边框 -->
        <div v-if="conversationTitle" class="topbar-conv-wrap">
            <span class="topbar-conv" :title="conversationTitle">{{ conversationTitle }}</span>
            <span v-if="workspace" class="topbar-ws" :title="workspace">{{ workspace }}</span>
        </div>
    </header>
</template>

<style scoped>
.account-wrap {
    position: relative;
    display: flex;
    align-items: center;
}
.account-btn.on {
    color: var(--accent);
    background: var(--bg-hover);
}
.account-menu {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 40;
    min-width: 148px;
    display: flex;
    flex-direction: column;
    padding: 4px;
    background: var(--bg-panel, var(--bg));
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.16);
}
.account-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 10px;
    border: none;
    background: transparent;
    color: var(--fg);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    border-radius: 4px;
}
.account-item:hover {
    background: var(--bg-hover);
}
</style>

