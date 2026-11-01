<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import LineIcon from '../assets/LineIcon.vue';

const props = defineProps({
    projectId: { type: String, default: '' },
    embedded: { type: Boolean, default: false },
});
const emit = defineEmits(['close']);

const userId = ref(localStorage.getItem('mazi.memory.userId') || 'local');
const query = ref('');
const items = ref([]);
const loading = ref(false);
const error = ref('');
const notice = ref('');
const editingId = ref('');
const editText = ref('');
const form = ref({
    kind: 'preference',
    text: '',
    tags: '',
    inferred: false,
});

const activeItems = computed(() => items.value.filter((item) => item.status === 'active'));
const candidateCount = computed(
    () =>
        activeItems.value.filter(
            (item) => item.provenance?.confidence === 'pending_confirmation',
        ).length,
);

onMounted(load);

async function load() {
    loading.value = true;
    error.value = '';
    notice.value = '';
    try {
        localStorage.setItem('mazi.memory.userId', userId.value.trim() || 'local');
        const params = new URLSearchParams({
            userId: userId.value.trim() || 'local',
            limit: '200',
        });
        if (query.value.trim()) params.set('query', query.value.trim());
        const data = await api(`/api/memory?${params.toString()}`);
        items.value = data.items ?? [];
    } catch (err) {
        error.value = String(err);
    } finally {
        loading.value = false;
    }
}

async function createMemory() {
    const text = form.value.text.trim();
    if (!text) return;
    loading.value = true;
    error.value = '';
    try {
        await api('/api/memory', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                userId: userId.value.trim() || 'local',
                kind: form.value.kind,
                text,
                ...(props.projectId ? { projectId: props.projectId } : {}),
                tags: form.value.tags
                    .split(',')
                    .map((tag) => tag.trim())
                    .filter(Boolean),
                ...(form.value.inferred
                    ? {
                          provenance: {
                              source: 'model_inferred',
                              confidence: 'pending_confirmation',
                          },
                      }
                    : {}),
            }),
        });
        form.value.text = '';
        form.value.tags = '';
        notice.value = form.value.inferred ? '候选记忆已写入，等待确认。' : '记忆已写入。';
        await load();
    } catch (err) {
        error.value = String(err);
    } finally {
        loading.value = false;
    }
}

async function act(memoryId, action, text) {
    loading.value = true;
    error.value = '';
    try {
        await api(`/api/memory/${encodeURIComponent(memoryId)}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action, ...(text !== undefined ? { text } : {}) }),
        });
        editingId.value = '';
        await load();
    } catch (err) {
        error.value = String(err);
    } finally {
        loading.value = false;
    }
}

async function forget(memoryId) {
    loading.value = true;
    error.value = '';
    try {
        await api(`/api/memory/${encodeURIComponent(memoryId)}`, { method: 'DELETE' });
        notice.value = '记忆已删除并留下墓碑，后续召回不会再次使用。';
        await load();
    } catch (err) {
        error.value = String(err);
    } finally {
        loading.value = false;
    }
}

function beginCorrect(item) {
    editingId.value = item.id;
    editText.value = item.text;
}

function time(value) {
    return value ? new Date(value).toLocaleString() : '-';
}

function provenanceLabel(item) {
    const provenance = item.provenance ?? {};
    return [provenance.source, provenance.confidence, provenance.trustTier]
        .filter(Boolean)
        .join(' · ');
}
</script>

<template>
    <section class="memory-page" :class="{ embedded }">
        <header v-if="!embedded" class="memory-head">
            <div class="memory-title">
                <LineIcon name="lightbulb" :size="17" />
                <strong>个人长期记忆</strong>
                <span>{{ activeItems.length }} 条生效 · {{ candidateCount }} 条待确认</span>
            </div>
            <button type="button" @click="emit('close')">返回对话</button>
        </header>

        <div class="memory-layout">
            <aside class="memory-compose">
                <div class="memory-section-title">写入记忆</div>
                <label>
                    用户
                    <input v-model="userId" @change="load" />
                </label>
                <label>
                    类型
                    <select v-model="form.kind">
                        <option value="preference">偏好</option>
                        <option value="fact">事实</option>
                        <option value="episode">经历</option>
                        <option value="decision">决策</option>
                        <option value="relationship">关系</option>
                    </select>
                </label>
                <label>
                    内容
                    <textarea
                        v-model="form.text"
                        rows="5"
                        placeholder="例如：回答先给结论，再给证据"
                    ></textarea>
                </label>
                <label>
                    标签
                    <input v-model="form.tags" placeholder="风格, 输出偏好" />
                </label>
                <label class="memory-check">
                    <input v-model="form.inferred" type="checkbox" />
                    作为模型推断候选，等待人工确认
                </label>
                <p v-if="projectId" class="memory-project">
                    关联项目：<code>{{ projectId }}</code>
                </p>
                <button
                    class="memory-primary"
                    type="button"
                    :disabled="loading || !form.text.trim()"
                    @click="createMemory"
                >
                    {{ form.inferred ? '保存候选' : '保存记忆' }}
                </button>
                <p class="memory-tip">
                    明示事实直接生效；模型推断默认待确认。删除会生成 tombstone，不会继续参与召回。
                </p>
            </aside>

            <main class="memory-main">
                <div class="memory-toolbar">
                    <input
                        v-model="query"
                        placeholder="按语义关键词召回…"
                        @keydown.enter="load"
                    />
                    <button type="button" :disabled="loading" @click="load">
                        {{ loading ? '加载中…' : '召回' }}
                    </button>
                </div>

                <p v-if="error" class="memory-error">{{ error }}</p>
                <p v-if="notice" class="memory-notice">{{ notice }}</p>

                <div class="memory-list">
                    <article v-for="item in items" :key="item.id" class="memory-card">
                        <div class="memory-card-head">
                            <span class="memory-kind">{{ item.kind }}</span>
                            <span
                                class="memory-confidence"
                                :class="{
                                    pending:
                                        item.provenance?.confidence === 'pending_confirmation',
                                }"
                            >
                                {{ item.provenance?.confidence || 'unknown' }}
                            </span>
                            <span class="memory-version">v{{ item.version }}</span>
                        </div>
                        <template v-if="editingId === item.id">
                            <textarea v-model="editText" rows="3"></textarea>
                            <div class="memory-actions">
                                <button type="button" @click="act(item.id, 'correct', editText)">
                                    保存纠正
                                </button>
                                <button type="button" @click="editingId = ''">取消</button>
                            </div>
                        </template>
                        <template v-else>
                            <p class="memory-text">{{ item.text }}</p>
                            <div class="memory-meta">
                                <span>{{ provenanceLabel(item) }}</span>
                                <span>
                                    importance {{ Number(item.importance ?? 0).toFixed(2) }}
                                </span>
                                <span>{{ time(item.createdAt) }}</span>
                            </div>
                            <div class="memory-tags">
                                <span v-for="tag in item.tags ?? []" :key="tag">{{ tag }}</span>
                                <span v-if="item.projectId" class="project">
                                    {{ item.projectId }}
                                </span>
                            </div>
                            <div class="memory-actions">
                                <button
                                    v-if="
                                        item.provenance?.confidence === 'pending_confirmation'
                                    "
                                    type="button"
                                    @click="act(item.id, 'confirm')"
                                >
                                    确认
                                </button>
                                <button type="button" @click="beginCorrect(item)">纠正</button>
                                <button type="button" class="danger" @click="forget(item.id)">
                                    删除
                                </button>
                            </div>
                        </template>
                    </article>
                    <div v-if="!loading && !items.length" class="memory-empty">
                        没有匹配的记忆。后续会话可以在同一用户下跨项目召回。
                    </div>
                </div>
            </main>
        </div>
    </section>
</template>

<style scoped>
.memory-page {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-height: 0;
    padding: 12px 16px 16px;
    gap: 10px;
    overflow: hidden;
}
.memory-page.embedded {
    padding: 0;
}
.memory-page.embedded .memory-layout {
    grid-template-columns: 250px minmax(0, 1fr);
}
.memory-head,
.memory-title,
.memory-toolbar,
.memory-card-head,
.memory-actions {
    display: flex;
    align-items: center;
}
.memory-head {
    justify-content: space-between;
}
.memory-title {
    gap: 8px;
}
.memory-title span,
.memory-project,
.memory-tip,
.memory-meta,
.memory-version,
.memory-empty {
    color: var(--fg-tertiary);
    font-size: 11px;
}
.memory-head button,
.memory-toolbar button,
.memory-primary,
.memory-actions button {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
    color: var(--fg);
    padding: 5px 10px;
    font-size: 12px;
    cursor: pointer;
}
.memory-head button:hover,
.memory-toolbar button:hover,
.memory-actions button:hover {
    background: var(--bg-hover);
}
.memory-layout {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 280px minmax(0, 1fr);
    gap: 12px;
}
.memory-compose,
.memory-main {
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-md);
    background: var(--bg-panel);
}
.memory-compose {
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    overflow-y: auto;
}
.memory-section-title {
    font-size: 13px;
    font-weight: 600;
}
.memory-compose label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 11px;
    color: var(--fg-secondary);
}
.memory-compose input,
.memory-compose select,
.memory-compose textarea,
.memory-toolbar input,
.memory-card textarea {
    box-sizing: border-box;
    width: 100%;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--fg);
    padding: 6px 8px;
    font: inherit;
    font-size: 12px;
    resize: vertical;
}
.memory-compose .memory-check {
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: center;
}
.memory-compose .memory-check input {
    width: auto;
}
.memory-project {
    margin: 0;
    overflow-wrap: anywhere;
}
.memory-primary {
    background: var(--accent);
    border-color: transparent;
    color: #fff;
}
.memory-primary:disabled,
.memory-toolbar button:disabled {
    opacity: 0.55;
}
.memory-tip {
    margin: 0;
    line-height: 1.55;
}
.memory-main {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 10px;
    gap: 8px;
}
.memory-toolbar {
    gap: 8px;
}
.memory-toolbar input {
    flex: 1;
}
.memory-error,
.memory-notice {
    margin: 0;
    font-size: 12px;
}
.memory-error {
    color: var(--error);
}
.memory-notice {
    color: var(--ok);
}
.memory-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    align-content: start;
    gap: 8px;
}
.memory-card {
    min-width: 0;
    padding: 10px;
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
    background: var(--bg);
}
.memory-card-head {
    gap: 6px;
}
.memory-kind {
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--bg-hover);
    color: var(--fg-secondary);
    font-size: 10px;
}
.memory-confidence {
    color: var(--ok);
    font-size: 10px;
}
.memory-confidence.pending {
    color: var(--warn);
}
.memory-version {
    margin-left: auto;
}
.memory-text {
    margin: 9px 0 7px;
    color: var(--fg);
    font-size: 13px;
    line-height: 1.55;
    white-space: pre-wrap;
}
.memory-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 10px;
}
.memory-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: 8px 0;
}
.memory-tags span {
    padding: 1px 6px;
    border: 1px solid var(--border-soft);
    border-radius: 999px;
    color: var(--fg-tertiary);
    font-size: 9px;
}
.memory-tags .project {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.memory-actions {
    justify-content: flex-end;
    gap: 6px;
    margin-top: 8px;
}
.memory-actions button {
    padding: 3px 8px;
    font-size: 11px;
}
.memory-actions .danger {
    color: var(--error);
}
.memory-empty {
    grid-column: 1 / -1;
    padding: 36px;
    text-align: center;
    border: 1px dashed var(--border);
    border-radius: var(--radius-md);
}
@media (max-width: 900px) {
    .memory-layout {
        grid-template-columns: 1fr;
        overflow-y: auto;
    }
    .memory-compose {
        max-height: 360px;
    }
}
</style>
