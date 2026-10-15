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
const loading = ref(false);
const error = ref('');

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
        view.value = await api('/api/wiki' + query);
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
                <button type="button" :disabled="loading" @click="load">
                    {{ loading ? '刷新中…' : '刷新' }}
                </button>
                <button type="button" @click="emit('close')">返回对话</button>
            </div>
        </header>

        <p v-if="error" class="wiki-error">{{ error }}</p>
        <div v-if="isEmpty && !error" class="wiki-empty">
            {{ wikiEmptyText(targetWorkspace) }}
        </div>
        <div v-else-if="!error" class="wiki-body">
            <article class="wiki-panel">
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

            <article class="wiki-panel">
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
    display: grid;
    grid-template-columns: 1fr 1fr;
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
