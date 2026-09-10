<script setup>
/**
 * Sidebar — workspace projects and conversations.
 *
 * Projects and the default "随心聊" group share the same row treatment: a folder
 * icon that turns into a fold chevron on hover, a title that toggles the group,
 * and (projects only) a "..." menu for rename / add-conversation / delete.
 * Conversation rows expose a "..." menu with rename / archive / delete.
 *
 * The "..." menus render once as a viewport-fixed floating layer so they are
 * never clipped by the scrolling list.
 */
import { ref } from 'vue';
import LineIcon from '../assets/LineIcon.vue';

const props = defineProps({
    projects: { type: Array, default: () => [] },
    projectCollapsed: { type: Object, default: () => new Set() },
    generalConversations: { type: Array, default: () => [] },
    activeConversationId: { type: String, default: '' },
    apiLatency: { type: Number, default: null },
    conversations: { type: Array, default: () => [] },
});
const emit = defineEmits([
    'new-session',
    'open-system-picker',
    'toggle-project',
    'rename-project',
    'start-project-conversation',
    'remove-project',
    'open-conversation',
    'rename-conversation',
    'archive-conversation',
    'remove-conversation',
    'open-settings',
]);

/* Internal UI state */
const searchOpen = ref(false);
const q = ref('');
/** Open "..." menu: { kind: 'project' | 'conversation', item } or null. */
const menuTarget = ref(null);
/** Fixed position of the floating menu (left = trigger right edge). */
const menuPos = ref({ top: 0, left: 0, up: false });
/** Whether the default "随心聊" group is expanded. */
const freeChatOpen = ref(true);

/* Helpers */
function openMenu(event, kind, item) {
    const rect = event.currentTarget.getBoundingClientRect();
    // Flip the menu above the trigger when there is not enough room below.
    const up = rect.bottom + 140 > window.innerHeight;
    menuPos.value = {
        top: up ? rect.top - 6 : rect.bottom + 6,
        left: rect.right,
        up,
    };
    menuTarget.value = { kind, item };
}
function closeMenu() {
    menuTarget.value = null;
}
function isMenuOpen(kind, item) {
    return menuTarget.value !== null && menuTarget.value.kind === kind && menuTarget.value.item === item;
}
function toggleProject(path) {
    emit('toggle-project', path);
}
function isProjectOpen(path) {
    return !props.projectCollapsed.has(path);
}
function projectConversationItems(project) {
    return props.conversations.filter(
        (c) => c.workspace === project.path && c.projectId === project.path && !c.archived,
    );
}
function conversationTitle(conversation) {
    return conversation?.title || conversation?.input || '';
}
function relTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - new Date(ts).getTime();
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
    if (diff < 604800000) return Math.floor(diff / 86400000) + '天前';
    return new Date(ts).toLocaleDateString();
}
function isConversationActive(c) {
    return c.conversationId === props.activeConversationId;
}
function latencyColor() {
    if (props.apiLatency == null) return '#9ca3af';
    if (props.apiLatency < 100) return '#22c55e';
    if (props.apiLatency < 1000) return '#eab308';
    return '#ef4444';
}
function latencyText() {
    if (props.apiLatency == null) return 'offline';
    if (props.apiLatency > 999) return '999+ms';
    return props.apiLatency + 'ms';
}
</script>

<template>
    <div class="sidebar-new">
        <button class="primary new-session" @click="emit('new-session')">
            <LineIcon name="plus" size="15" />
            新会话
        </button>
    </div>
    <div class="workspace-head">
        <template v-if="searchOpen">
            <input v-model="q" class="search-input" placeholder="搜索会话…" autofocus />
            <span class="head-icons">
                <button class="head-icon" title="关闭搜索" @click.stop="searchOpen = false; q = ''">
                    <LineIcon name="close" size="14" />
                </button>
            </span>
        </template>
        <template v-else>
            <span>工作区</span>
            <span class="head-icons">
                <button class="head-icon" title="搜索" @click.stop="searchOpen = true">
                    <LineIcon name="search" size="14" />
                </button>
                <button class="head-icon" title="打开/创建工作区" @click.stop="emit('open-system-picker')">
                    <LineIcon name="plus" size="14" />
                </button>
            </span>
        </template>
    </div>
    <div class="sidebar-scroll" @scroll.passive="closeMenu">
        <!-- Project groups -->
        <div v-for="project in projects" :key="project.path" class="group">
            <div class="group-head" :class="{ 'menu-open': isMenuOpen('project', project) }">
                <button
                    class="group-toggle"
                    :title="isProjectOpen(project.path) ? '折叠' : '展开'"
                    @click="toggleProject(project.path)"
                >
                    <LineIcon class="icon-folder" name="folder" size="15" />
                    <LineIcon
                        class="icon-chevron"
                        :name="isProjectOpen(project.path) ? 'chevronDown' : 'chevronRight'"
                        size="15"
                    />
                </button>
                <span class="group-title" :title="project.path" @click="toggleProject(project.path)">
                    {{ project.title }}
                </span>
                <div class="menu-wrap">
                    <button class="menu-btn" title="更多" @click.stop="openMenu($event, 'project', project)">
                        <LineIcon name="more" size="14" />
                    </button>
                </div>
            </div>
            <ul v-if="isProjectOpen(project.path)" class="session-list">
                <li
                    v-for="c in projectConversationItems(project)"
                    :key="c.conversationId"
                    :class="{ active: isConversationActive(c), 'menu-open': isMenuOpen('conversation', c) }"
                    @click="emit('open-conversation', c)"
                >
                    <div class="session-title">{{ conversationTitle(c) }}</div>
                    <div class="session-time">{{ relTime(c.updatedAt || c.createdAt) }}</div>
                    <div class="menu-wrap session-menu-wrap">
                        <button class="menu-btn" title="更多" @click.stop="openMenu($event, 'conversation', c)">
                            <LineIcon name="more" size="13" />
                        </button>
                    </div>
                </li>
                <li v-if="!projectConversationItems(project).length" class="empty-sidebar">
                    暂无项目会话
                </li>
            </ul>
        </div>

        <!-- Default group: same row treatment as projects -->
        <div class="group">
            <div class="group-head">
                <button
                    class="group-toggle"
                    :title="freeChatOpen ? '折叠' : '展开'"
                    @click="freeChatOpen = !freeChatOpen"
                >
                    <LineIcon class="icon-folder" name="folder" size="15" />
                    <LineIcon
                        class="icon-chevron"
                        :name="freeChatOpen ? 'chevronDown' : 'chevronRight'"
                        size="15"
                    />
                </button>
                <span class="group-title" @click="freeChatOpen = !freeChatOpen">随心聊</span>
                <span class="group-count">{{ generalConversations.length }}</span>
            </div>
            <ul v-if="freeChatOpen" class="session-list">
                <li
                    v-for="c in generalConversations"
                    :key="c.conversationId"
                    :class="{ active: isConversationActive(c), 'menu-open': isMenuOpen('conversation', c) }"
                    @click="emit('open-conversation', c)"
                >
                    <div class="session-title">{{ conversationTitle(c) }}</div>
                    <div class="session-time">{{ relTime(c.updatedAt || c.createdAt) }}</div>
                    <div class="menu-wrap session-menu-wrap">
                        <button class="menu-btn" title="更多" @click.stop="openMenu($event, 'conversation', c)">
                            <LineIcon name="more" size="13" />
                        </button>
                    </div>
                </li>
                <li v-if="!generalConversations.length" class="empty-sidebar">暂无会话</li>
            </ul>
        </div>
    </div>
    <div class="sidebar-settings">
        <button class="settings-btn" @click="emit('open-settings')">
            <LineIcon name="settings" size="15" />
            系统设置
        </button>
        <span class="api-latency">
            <span class="latency-dot" :style="{ background: latencyColor() }"></span>
            <span class="latency-value" :style="{ color: latencyColor() }">{{ latencyText() }}</span>
        </span>
    </div>

    <!-- Viewport-fixed "..." menu: never clipped by the scrolling list. -->
    <div v-if="menuTarget" class="menu-backdrop" @click="closeMenu"></div>
    <div
        v-if="menuTarget"
        class="floating-menu"
        :class="{ 'floating-menu-up': menuPos.up }"
        :style="{ top: menuPos.top + 'px', left: menuPos.left + 'px' }"
    >
        <template v-if="menuTarget.kind === 'project'">
            <button @click="emit('rename-project', menuTarget.item); closeMenu()">
                <LineIcon name="rename" size="13" />重命名
            </button>
            <button @click="emit('start-project-conversation', menuTarget.item); closeMenu()">
                <LineIcon name="plus" size="13" />添加新会话
            </button>
            <button class="danger" @click="emit('remove-project', menuTarget.item); closeMenu()">
                <LineIcon name="trash" size="13" />删除项目
            </button>
        </template>
        <template v-else>
            <button @click="emit('rename-conversation', menuTarget.item); closeMenu()">
                <LineIcon name="rename" size="13" />重命名
            </button>
            <button @click="emit('archive-conversation', menuTarget.item); closeMenu()">
                <LineIcon name="archive" size="13" />归档
            </button>
            <button class="danger" @click="emit('remove-conversation', menuTarget.item); closeMenu()">
                <LineIcon name="trash" size="13" />删除
            </button>
        </template>
    </div>
</template>

<style scoped>
.sidebar-new {
    padding: 8px 12px 10px;
}
.new-session {
    width: auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 6px 14px;
}
.workspace-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 14px 4px;
    font-size: 14px;
    font-weight: 600;
    color: var(--fg-secondary);
    height: 36px;
    box-sizing: border-box;
}
.head-icons {
    display: flex;
    gap: 2px;
}
.head-icon {
    width: 22px;
    height: 22px;
    border: none;
    background: transparent;
    color: var(--fg-tertiary);
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
}
.head-icon:hover {
    background: var(--bg-hover);
    color: var(--fg);
}
.search-input {
    flex: 1;
    height: 24px;
    padding: 0 8px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--bg-panel);
    color: var(--fg);
    font-size: 13px;
    outline: none;
    min-width: 0;
    box-sizing: border-box;
}
.search-input:focus {
    border-color: var(--accent);
}
.sidebar-scroll {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
}
.group {
    margin-bottom: 4px;
}
.group-head {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 5px 8px 5px 10px;
}
/* Folder icon by default; becomes a fold chevron while the row is hovered. */
.group-toggle {
    width: 24px;
    height: 24px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    color: var(--fg-tertiary);
    border-radius: 4px;
    cursor: pointer;
    padding: 0;
}
.group-toggle:hover {
    background: var(--bg-hover);
    color: var(--fg);
}
.group-toggle .icon-chevron {
    display: none;
}
.group-head:hover .group-toggle .icon-folder {
    display: none;
}
.group-head:hover .group-toggle .icon-chevron {
    display: block;
}
.group-title {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    font-weight: 500;
    color: var(--fg-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
    padding: 3px 0;
}
.group-title:hover {
    color: var(--fg);
}
.group-count {
    font-size: 11px;
    font-weight: 500;
    color: var(--fg-tertiary);
    padding-right: 4px;
}
/* "..." trigger: hidden until the row is hovered or its menu is open. */
.menu-wrap {
    position: relative;
    flex-shrink: 0;
    display: flex;
}
.menu-btn {
    width: 22px;
    height: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    color: var(--fg-tertiary);
    border-radius: 4px;
    cursor: pointer;
    padding: 0;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.1s ease;
}
.group-head:hover .menu-btn,
.session-list li:hover .menu-btn,
.group-head.menu-open .menu-btn,
.session-list li.menu-open .menu-btn {
    opacity: 1;
    pointer-events: auto;
}
.menu-btn:hover {
    background: var(--bg-hover);
    color: var(--fg);
}
.menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 60;
}
.floating-menu {
    position: fixed;
    transform: translateX(-100%);
    min-width: 150px;
    display: flex;
    flex-direction: column;
    padding: 4px;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: var(--shadow-lg);
    z-index: 61;
}
.floating-menu-up {
    transform: translate(-100%, -100%);
}
.floating-menu button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 8px;
    border: none;
    background: transparent;
    color: var(--fg);
    font-size: 13px;
    border-radius: 5px;
    cursor: pointer;
    text-align: left;
    white-space: nowrap;
}
.floating-menu button:hover {
    background: var(--bg-hover);
}
.floating-menu button.danger {
    color: var(--error);
}
.floating-menu button.danger:hover {
    background: var(--error-soft);
}
.session-list {
    list-style: none;
    margin: 0;
    /* Indent rows so their content aligns right after the group icon. */
    padding: 0 6px 0 30px;
}
.session-list li {
    position: relative;
    padding: 6px 26px 6px 8px;
    border-radius: 6px;
    cursor: pointer;
}
.session-list li:hover {
    background: var(--bg-hover);
}
.session-list li.active {
    background: var(--bg-active);
}
.session-title {
    font-size: 13px;
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.session-time {
    font-size: 11px;
    color: var(--fg-tertiary);
    margin-top: 2px;
}
.session-menu-wrap {
    position: absolute;
    top: 4px;
    right: 4px;
}
.empty-sidebar {
    padding: 8px;
    font-size: 12px;
    color: var(--fg-tertiary);
    text-align: center;
}
.sidebar-settings {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 10px;
    border-top: 1px solid var(--border-soft);
}
.settings-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    border: none;
    background: transparent;
    color: var(--fg-secondary);
    font-size: 13px;
    border-radius: 6px;
    cursor: pointer;
}
.settings-btn:hover {
    background: var(--bg-hover);
    color: var(--fg);
}
.api-latency {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    font-family: ui-monospace, monospace;
}
.latency-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
}
.latency-value {
    min-width: 5ch;
    text-align: right;
}
</style>
