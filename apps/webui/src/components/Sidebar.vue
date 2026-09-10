<script setup>
import { ref } from 'vue';
import LineIcon from '../LineIcon.vue';

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
    'remove-conversation',
    'start-general-conversation',
    'open-settings',
]);

/* Internal UI state */
const searchOpen = ref(false);
const q = ref('');
const projectMenuFor = ref('');

/* Helpers */
function isProjectOpen(path) {
    return !props.projectCollapsed.has(path);
}
function projectConversationItems(project) {
    return props.conversations.filter((c) => c.workspaceRoot === project.path);
}
function conversationTitle(conversation) {
    return conversation?.title || conversation?.input || '';
}
function relTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - new Date(ts).getTime();
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}天前`;
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
    return `${props.apiLatency}ms`;
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
        <span>工作区</span>
        <span class="head-icons">
            <button class="head-icon" title="搜索" @click.stop="searchOpen = !searchOpen">
                <LineIcon name="search" size="14" />
            </button>
            <button class="head-icon" title="打开/创建工作区" @click.stop="emit('open-system-picker')">
                <LineIcon name="plus" size="14" />
            </button>
        </span>
    </div>
    <div v-if="searchOpen" class="search-box">
        <input v-model="q" placeholder="搜索会话…" />
    </div>
    <div class="sidebar-scroll">
        <div v-for="project in projects" :key="project.path" class="group">
            <div
                class="group-head project-head"
                :title="project.path"
                @mouseenter="projectMenuFor = project.path"
                @mouseleave="projectMenuFor = ''"
            >
                <button
                    class="head-icon project-fold"
                    :title="isProjectOpen(project.path) ? '折叠' : '展开'"
                    @click.stop="emit('toggle-project', project.path)"
                >
                    <LineIcon :name="isProjectOpen(project.path) ? 'chevronDown' : 'chevronRight'" size="13" />
                </button>
                <span class="project-title">{{ project.title }}</span>
                <button
                    v-if="projectMenuFor === project.path"
                    class="head-icon"
                    title="重命名项目"
                    @click.stop="emit('rename-project', project)"
                >
                    <LineIcon name="rename" size="13" />
                </button>
                <button
                    v-if="projectMenuFor === project.path"
                    class="head-icon project-add"
                    title="添加项目会话"
                    @click.stop="emit('start-project-conversation', project)"
                >
                    <LineIcon name="plus" size="13" />
                </button>
                <button
                    v-if="projectMenuFor === project.path"
                    class="head-icon project-remove"
                    title="删除项目配置"
                    @click.stop="emit('remove-project', project)"
                >
                    <LineIcon name="trash" size="13" />
                </button>
            </div>
            <ul class="session-list">
                <template v-if="isProjectOpen(project.path)">
                    <li
                        v-for="c in projectConversationItems(project)"
                        :key="c.conversationId"
                        :class="{ active: isConversationActive(c) }"
                        @click="emit('open-conversation', c)"
                    >
                        <div class="session-title">{{ conversationTitle(c) }}</div>
                        <div class="session-actions">
                            <button title="重命名会话" @click.stop="emit('rename-conversation', c)"><LineIcon name="rename" size="13" /></button>
                            <button title="删除会话" @click.stop="emit('remove-conversation', c)"><LineIcon name="trash" size="13" /></button>
                        </div>
                        <div class="session-time">{{ relTime(c.updatedAt || c.createdAt) }}</div>
                    </li>
                    <li v-if="!projectConversationItems(project).length" class="empty-sidebar">
                        暂无项目会话
                    </li>
                </template>
            </ul>
        </div>
        <div class="group">
            <div class="group-head">
                <span>会话 · {{ generalConversations.length }}</span>
                <span class="head-icons">
                    <button class="head-icon" title="添加新会话" @click.stop="emit('start-general-conversation')">
                        <LineIcon name="plus" size="14" />
                    </button>
                </span>
            </div>
            <ul class="session-list">
                <li
                    v-for="c in generalConversations"
                    :key="c.conversationId"
                    :class="{ active: isConversationActive(c) }"
                    @click="emit('open-conversation', c)"
                >
                    <div class="session-title">{{ conversationTitle(c) }}</div>
                    <div class="session-actions">
                        <button title="重命名会话" @click.stop="emit('rename-conversation', c)"><LineIcon name="rename" size="13" /></button>
                        <button title="删除会话" @click.stop="emit('remove-conversation', c)"><LineIcon name="trash" size="13" /></button>
                    </div>
                    <div class="session-time">{{ relTime(c.updatedAt || c.createdAt) }}</div>
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
</template>

<style scoped>
.sidebar-new {
    padding: 2px 0 8px;
}
.new-session {
    width: 100%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
}
.workspace-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 14px 4px;
    font-size: 11px;
    font-weight: 600;
    color: var(--fg-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
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
.search-box {
    padding: 4px 10px 8px;
}
.search-box input {
    width: 100%;
    padding: 5px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-panel);
    color: var(--fg);
    font-size: 12px;
    outline: none;
}
.search-box input:focus {
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
    justify-content: space-between;
    padding: 6px 14px;
    font-size: 11px;
    font-weight: 600;
    color: var(--fg-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
}
.project-head {
    cursor: default;
}
.project-fold {
    margin-right: 2px;
}
.project-title {
    flex: 1;
    font-size: 12px;
    font-weight: 500;
    color: var(--fg-secondary);
    text-transform: none;
    letter-spacing: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.session-list {
    list-style: none;
    margin: 0;
    padding: 0 6px;
}
.session-list li {
    display: flex;
    flex-direction: column;
    padding: 6px 8px;
    border-radius: 6px;
    cursor: pointer;
    gap: 2px;
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
.session-actions {
    display: none;
    gap: 2px;
}
.session-list li:hover .session-actions {
    display: flex;
}
.session-actions button {
    width: 20px;
    height: 20px;
    border: none;
    background: transparent;
    color: var(--fg-tertiary);
    border-radius: 3px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
}
.session-actions button:hover {
    background: var(--bg);
    color: var(--fg);
}
.session-time {
    font-size: 11px;
    color: var(--fg-tertiary);
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
