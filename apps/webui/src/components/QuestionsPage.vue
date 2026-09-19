<script setup>
/**
 * QuestionsPage — 用户问题（个人中心 → 问题）。
 *
 * 数据来自 GET /api/users/:id/questions：问题原文 + 有效标签（言说类型/主域/子类/话题），
 * 支持轴过滤与用户标签覆盖（append-only）。见 docs/用户问题标签与分类设计.md。
 */
import { onMounted, ref } from 'vue';
import LineIcon from '../assets/LineIcon.vue';
import { addQuestionLabels, fetchQuestionTaxonomy, fetchUserQuestions } from '../scripts/store.ts';

const emit = defineEmits(['close']);

const questions = ref([]);
const taxonomy = ref(null);
const loading = ref(true);
const error = ref('');
const filters = ref({ type: '', domain: '', q: '' });
const editingId = ref('');
const draft = ref({ axis: 'topic', label: '' });

function labelOptions(axis) {
    if (!taxonomy.value) return [];
    if (axis === 'domain') return Object.keys(taxonomy.value.domains);
    if (axis === 'speech_act') return taxonomy.value.speechAct;
    if (axis === 'category') return Object.values(taxonomy.value.domains).flat();
    return [];
}

async function reload() {
    loading.value = true;
    error.value = '';
    try {
        questions.value = await fetchUserQuestions('all', {
            ...(filters.value.type ? { type: filters.value.type } : {}),
            ...(filters.value.domain ? { domain: filters.value.domain } : {}),
            ...(filters.value.q ? { q: filters.value.q } : {}),
            limit: 200,
        });
    } catch (e) {
        error.value = String(e);
    } finally {
        loading.value = false;
    }
}

onMounted(async () => {
    try {
        taxonomy.value = await fetchQuestionTaxonomy();
    } catch {
        // 分类法不可用时仍可浏览问题（标签只读）。
    }
    await reload();
});

function chips(question) {
    const effective = question.effective || {};
    const rows = [];
    for (const value of effective.speech_act || []) rows.push({ axis: 'type', label: value });
    for (const value of effective.domain || []) rows.push({ axis: 'domain', label: value });
    for (const value of effective.category || []) rows.push({ axis: 'category', label: value });
    for (const value of effective.topic || []) rows.push({ axis: 'topic', label: value });
    return rows;
}
function timeOf(ts) {
    return new Date(ts).toLocaleString();
}
function startEdit(question) {
    editingId.value = question.questionId;
    draft.value = { axis: 'topic', label: '' };
}
async function saveLabel(question) {
    const label = draft.value.label.trim();
    if (!label) return;
    try {
        await addQuestionLabels(question.questionId, [
            { axis: draft.value.axis, label, source: 'user' },
        ]);
        editingId.value = '';
        await reload();
    } catch (e) {
        error.value = String(e);
    }
}
</script>

<template>
    <div class="page-card">
        <div class="page-heading">
            <button class="icon-btn back-btn" title="返回会话" @click="emit('close')">
                <LineIcon name="chevronRight" size="16" />
            </button>
            <h1>问题</h1>
            <span class="question-badge">{{ questions.length }} 条</span>
        </div>

        <div class="question-filters">
            <select v-model="filters.type" @change="reload">
                <option value="">全部类型</option>
                <option v-for="value in taxonomy?.speechAct || []" :key="value" :value="value">
                    {{ value }}
                </option>
            </select>
            <select v-model="filters.domain" @change="reload">
                <option value="">全部主域</option>
                <option v-for="value in Object.keys(taxonomy?.domains || {})" :key="value" :value="value">
                    {{ value }}
                </option>
            </select>
            <input
                v-model="filters.q"
                class="question-search"
                placeholder="搜索问题原文"
                @keyup.enter="reload"
            />
            <button class="setting-sync" @click="reload">查询</button>
        </div>

        <div v-if="error" class="empty-hint">{{ error }}</div>
        <div v-else-if="loading" class="empty-hint">加载中…</div>
        <div v-else-if="questions.length" class="question-list">
            <div v-for="question in questions" :key="question.questionId" class="question-row">
                <div class="question-text">
                    <span v-if="question.derived" class="question-derived" title="历史回填">回填</span>
                    {{ question.text }}
                </div>
                <div class="question-meta">
                    <span
                        v-for="chip in chips(question)"
                        :key="chip.axis + chip.label"
                        class="question-chip"
                        :class="'chip-' + chip.axis"
                    >{{ chip.label }}</span>
                    <span class="question-time">{{ timeOf(question.ts) }}</span>
                    <button class="question-edit" title="添加/覆盖标签" @click="startEdit(question)">
                        ＋标签
                    </button>
                </div>
                <div v-if="editingId === question.questionId" class="question-editor">
                    <select v-model="draft.axis">
                        <option value="speech_act">言说类型</option>
                        <option value="domain">主域</option>
                        <option value="category">子类</option>
                        <option value="topic">话题</option>
                    </select>
                    <select v-if="labelOptions(draft.axis).length" v-model="draft.label">
                        <option value="">选择…</option>
                        <option v-for="value in labelOptions(draft.axis)" :key="value" :value="value">
                            {{ value }}
                        </option>
                    </select>
                    <input v-else v-model="draft.label" placeholder="标签（小写连字符）" />
                    <button class="setting-sync primary" @click="saveLabel(question)">添加</button>
                    <button class="setting-sync" @click="editingId = ''">取消</button>
                </div>
            </div>
        </div>
        <div v-else class="empty-hint">暂无问题（新会话或回填历史提问后出现）</div>
    </div>
</template>

<style scoped>
.question-badge {
    margin-left: auto;
    font-size: 12px;
    color: var(--fg-tertiary);
}
.question-filters {
    display: flex;
    gap: 8px;
    margin-bottom: 14px;
}
.question-filters select,
.question-search,
.question-editor select,
.question-editor input {
    padding: 5px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-panel);
    color: var(--fg);
    font-size: 13px;
}
.question-search {
    flex: 1;
}
.question-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.question-row {
    padding: 10px 12px;
    border: 1px solid var(--border-soft);
    border-radius: 8px;
    background: var(--bg-hover);
}
.question-text {
    font-size: 14px;
    color: var(--fg);
    line-height: 1.5;
    word-break: break-word;
}
.question-derived {
    margin-right: 6px;
    padding: 0 5px;
    border-radius: 4px;
    font-size: 11px;
    color: var(--fg-tertiary);
    border: 1px solid var(--border);
}
.question-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-top: 8px;
}
.question-chip {
    padding: 1px 7px;
    border-radius: 10px;
    font-size: 11px;
    background: var(--accent-soft);
    color: var(--accent-text);
}
.chip-type {
    background: var(--warn-soft);
    color: var(--warn);
}
.chip-topic {
    background: var(--bg-panel);
    color: var(--fg-secondary);
    border: 1px solid var(--border);
}
.question-time {
    margin-left: auto;
    font-family: ui-monospace, monospace;
    font-size: 11px;
    color: var(--fg-tertiary);
}
.question-edit {
    border: 1px solid var(--border);
    background: var(--bg-panel);
    color: var(--fg-secondary);
    border-radius: 6px;
    font-size: 11px;
    padding: 2px 8px;
    cursor: pointer;
}
.question-editor {
    display: flex;
    gap: 8px;
    margin-top: 8px;
}
</style>
