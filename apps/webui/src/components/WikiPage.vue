<script setup>
/**
 * WikiPage —— 项目 wiki 只读视图（docs/项目wiki设计.md §11）。
 * 展示状态快照 + 变更日志（时间 | 改动）；写入在 runtime，此处只读。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api.js';
import LineIcon from '../assets/LineIcon.vue';
import { renderMarkdown } from '../scripts/markdown.ts';
import { freeChatWorkspace, workspaceRoot } from '../scripts/store.js';
import {
    entryCountLabel,
    recentEntries,
    snapshotSections,
    wikiEmptyText,
    wikiUpdatedLabel,
} from '../scripts/wiki.ts';

const props = defineProps({
    workspace: { type: String, default: '' },
});
const emit = defineEmits(['close']);

const view = ref(null);
const board = ref(null);
const loading = ref(false);
const error = ref('');
const reconciledAt = ref(0);

/** 目标工作区：跟随顶部栏（项目会话 = 会话工作区；随心聊 = 已选/默认工作区）。 */
const targetWorkspace = computed(
    () => props.workspace || workspaceRoot.value || freeChatWorkspace.value || '',
);

async function load() {
    loading.value = true;
    error.value = '';
    try {
        const query = targetWorkspace.value
            ? '?workspace=' + encodeURIComponent(targetWorkspace.value)
            : '';
        const wiki = await api('/api/wiki' + query);
        view.value = wiki;
        board.value = wiki.blackboard;
    } catch (err) {
        error.value = String(err);
        view.value = null;
    } finally {
        loading.value = false;
    }
}

onMounted(load);
watch(targetWorkspace, () => {
    void load();
});

const sections = computed(() => snapshotSections(view.value?.snapshot ?? null));
const entries = computed(() => recentEntries(view.value?.entries, 50));
const isEmpty = computed(() => view.value === null || view.value.empty === true);
const boardSections = computed(() => {
    const value = board.value;
    if (!value) return [];
    return [
        { title: '架构', items: [value.architectureSummary] },
        { title: '技术栈', items: value.stack },
        { title: '核心模块', items: value.coreModules },
        { title: '接口', items: value.interfaces },
        { title: '约束', items: value.constraints },
        { title: '进行中', items: value.activeGoals },
        { title: '已完成', items: value.completedMilestones },
        { title: '已知问题', items: value.knownIssues, tone: 'warn' },
        { title: '决策', items: value.decisions },
        { title: '下一步', items: value.nextActions },
        { title: '最近变化', items: value.recentChanges },
    ]
        .map((section) => ({
            ...section,
            items: (section.items ?? []).filter(Boolean),
        }))
        .filter((section) => section.items.length > 0);
});

async function reconcileBoard() {
    loading.value = true;
    error.value = '';
    try {
        const data = await api('/api/wiki/reconcile' + queryForWorkspace(), {
            method: 'POST',
        });
        board.value = data.blackboard;
        reconciledAt.value = Date.now();
    } catch (err) {
        error.value = String(err);
    } finally {
        loading.value = false;
    }
}

function queryForWorkspace() {
    return targetWorkspace.value
        ? '?workspace=' + encodeURIComponent(targetWorkspace.value)
        : '';
}
</script>

<template>
    <section class="wiki-page">
        <header class="wiki-head">
            <div class="wiki-title">
                <LineIcon name="observation" :size="16" />
                <strong>项目 Wiki</strong>
                <span v-if="view && !view.empty" class="wiki-meta">
                    {{ view.project }} · {{ view.workspace }}
                </span>
            </div>
            <div class="wiki-actions">
                <span class="wiki-updated">
                    更新于 {{ wikiUpdatedLabel(view?.updatedAt) }} ·
                    {{ entryCountLabel(view?.entries?.length ?? 0) }}
                </span>
                <button type="button" :disabled="loading" @click="reconcileBoard">
                    检查源漂移
                </button>
                <button type="button" :disabled="loading" @click="load">
                    {{ loading ? '刷新中…' : '刷新' }}
                </button>
                <button type="button" @click="emit('close')">返回对话</button>
            </div>
        </header>

        <p v-if="error" class="wiki-error">{{ error }}</p>
        <p v-if="reconciledAt" class="wiki-notice">
            已检查项目源指纹；结构化知识不会被自动全量重写。
        </p>
        <div v-if="isEmpty && !board && !error" class="wiki-empty">
            {{ wikiEmptyText(targetWorkspace) }}
        </div>
        <div v-else-if="!error" class="wiki-body">
            <article v-if="board" class="wiki-panel wiki-board">
                <div class="wiki-board-head">
                    <h3>项目知识</h3>
                    <span>v{{ board.version }} · {{ board.status }}</span>
                </div>
                <p class="wiki-purpose">{{ board.purpose || '尚未形成项目目的摘要。' }}</p>
                <div class="wiki-board-grid">
                    <section v-for="section in boardSections" :key="section.title">
                        <h4>{{ section.title }}</h4>
                        <ul>
                            <li
                                v-for="(item, index) in section.items.slice(0, 12)"
                                :key="section.title + ':' + index"
                                :class="section.tone"
                            >
                                {{ item }}
                            </li>
                        </ul>
                    </section>
                </div>
                <div class="wiki-evidence">
                    <strong>证据与源指纹</strong>
                    <code>{{ board.sourceFingerprint }}</code>
                    <ul>
                        <li
                            v-for="evidence in board.evidenceRefs.slice(-12).reverse()"
                            :key="evidence.ref"
                        >
                            <span>{{ evidence.kind }}</span>
                            <code>{{ evidence.ref }}</code>
                        </li>
                    </ul>
                </div>
            </article>

            <article v-if="!isEmpty" class="wiki-panel">
                <h3>状态快照</h3>
                <template v-if="sections.length">
                    <section v-for="section in sections" :key="section.title" class="wiki-section">
                        <h4>{{ section.title }}</h4>
                        <!-- eslint-disable-next-line vue/no-v-html -->
                        <div class="wiki-md" v-html="renderMarkdown(section.body)"></div>
                    </section>
                </template>
                <p v-else class="wiki-muted">快照为空（尚未刷新）。</p>
            </article>

            <article v-if="!isEmpty" class="wiki-panel">
                <h3>变更日志</h3>
                <ul v-if="entries.length" class="wiki-log">
                    <li v-for="(entry, index) in entries" :key="entry.ts + ':' + index">
                        <time>{{ entry.ts }}</time>
                        <span>{{ entry.change }}</span>
                    </li>
                </ul>
                <p v-else class="wiki-muted">暂无变更记录。</p>
                <p v-if="view?.path" class="wiki-path">文件：{{ view.path }}</p>
            </article>
        </div>
    </section>
</template>

<style scoped>
.wiki-page {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    padding: 12px 16px 16px;
    gap: 10px;
    overflow: hidden;
}
.wiki-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
}
.wiki-title {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--fg);
}
.wiki-meta {
    color: var(--fg-tertiary);
    font-size: 12px;
}
.wiki-actions {
    display: flex;
    align-items: center;
    gap: 8px;
}
.wiki-updated {
    color: var(--fg-tertiary);
    font-size: 12px;
}
.wiki-actions button {
    border: 1px solid var(--border);
    background: var(--bg-panel);
    color: var(--fg);
    border-radius: var(--radius-sm);
    padding: 4px 10px;
    font-size: 12px;
    cursor: pointer;
}
.wiki-actions button:hover {
    background: var(--bg-hover);
}
.wiki-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
}
.wiki-panel {
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-md);
    background: var(--bg-panel);
    padding: 10px 12px;
    overflow-y: auto;
    min-height: 0;
}
.wiki-board {
    flex: 0 0 auto;
}
.wiki-board-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}
.wiki-board-head span {
    color: var(--fg-tertiary);
    font-size: 11px;
}
.wiki-purpose {
    margin: 8px 0 10px;
    color: var(--fg-secondary);
    font-size: 13px;
    line-height: 1.55;
}
.wiki-board-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
    gap: 8px;
}
.wiki-board-grid section {
    min-width: 0;
    padding: 8px;
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
    background: var(--bg);
}
.wiki-board-grid h4 {
    margin: 0 0 5px;
}
.wiki-board-grid ul {
    margin: 0;
    padding-left: 16px;
    color: var(--fg-secondary);
    font-size: 11px;
    line-height: 1.5;
}
.wiki-board-grid li.warn {
    color: var(--warn);
}
.wiki-evidence {
    margin-top: 10px;
    padding-top: 8px;
    border-top: 1px solid var(--border-soft);
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 5px 10px;
    font-size: 10px;
    color: var(--fg-tertiary);
}
.wiki-evidence > code {
    color: var(--fg-secondary);
}
.wiki-evidence ul {
    grid-column: 1 / -1;
    list-style: none;
    margin: 4px 0 0;
    padding: 0;
}
.wiki-evidence li {
    display: grid;
    grid-template-columns: 50px minmax(0, 1fr);
    gap: 6px;
    padding: 2px 0;
}
.wiki-evidence li code {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.wiki-notice {
    margin: 0;
    color: var(--ok);
    font-size: 12px;
}
.wiki-panel h3 {
    margin: 0 0 8px;
    font-size: 13px;
    color: var(--fg);
}
.wiki-section h4 {
    margin: 10px 0 4px;
    font-size: 12px;
    color: var(--fg-secondary);
}
.wiki-md {
    font-size: 13px;
    color: var(--fg-secondary);
    line-height: 1.6;
}
.wiki-log {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.wiki-log li {
    display: flex;
    gap: 8px;
    font-size: 13px;
    color: var(--fg-secondary);
    border-bottom: 1px dashed var(--border-soft);
    padding-bottom: 6px;
}
.wiki-log time {
    color: var(--fg-tertiary);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
}
.wiki-muted,
.wiki-path {
    color: var(--fg-tertiary);
    font-size: 12px;
}
.wiki-empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--fg-tertiary);
    font-size: 13px;
    border: 1px dashed var(--border-soft);
    border-radius: var(--radius-md);
}
.wiki-error {
    color: var(--error);
    font-size: 13px;
}
</style>
