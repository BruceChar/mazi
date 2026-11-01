<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api.js';
import LineIcon from '../assets/LineIcon.vue';

const props = defineProps({
    workspace: { type: String, default: '' },
});
const emit = defineEmits(['close']);

const board = ref(null);
const loading = ref(false);
const error = ref('');
const reconciledAt = ref(0);

const stale = computed(
    () =>
        board.value?.knownIssues?.some((issue) =>
            String(issue).includes('项目源指纹变化'),
        ) === true,
);

const sections = computed(() => {
    const value = board.value;
    if (!value) return [];
    return [
        { title: '架构', items: [value.architectureSummary] },
        { title: '技术栈', items: value.stack },
        { title: '核心模块', items: value.coreModules },
        { title: '接口', items: value.interfaces },
        { title: '约束', items: value.constraints },
        { title: '已完成', items: value.completedMilestones },
        { title: '已知问题', items: value.knownIssues, tone: 'warn' },
        { title: '决策', items: value.decisions },
        { title: '下一步', items: value.nextActions },
        { title: '最近变化', items: value.recentChanges },
    ].map((section) => ({
        ...section,
        items: (section.items ?? []).filter(Boolean),
    }));
});

onMounted(load);
watch(
    () => props.workspace,
    () => {
        void load();
    },
);

function query() {
    return props.workspace
        ? `?workspace=${encodeURIComponent(props.workspace)}`
        : '';
}

async function load() {
    loading.value = true;
    error.value = '';
    try {
        const data = await api(`/api/projects/blackboard${query()}`);
        board.value = data.board;
    } catch (err) {
        error.value = String(err);
        board.value = null;
    } finally {
        loading.value = false;
    }
}

async function reconcile() {
    loading.value = true;
    error.value = '';
    try {
        const data = await api(`/api/projects/blackboard/reconcile${query()}`, {
            method: 'POST',
        });
        board.value = data.board;
        reconciledAt.value = Date.now();
    } catch (err) {
        error.value = String(err);
    } finally {
        loading.value = false;
    }
}

function time(value) {
    return value ? new Date(value).toLocaleString() : '-';
}
</script>

<template>
    <section class="board-page">
        <header class="board-head">
            <div class="board-title">
                <LineIcon name="folder" :size="17" />
                <strong>项目黑板</strong>
                <span v-if="board">{{ board.name }} · {{ workspace }}</span>
            </div>
            <div class="board-actions">
                <span v-if="board" class="board-version">
                    v{{ board.version }} · {{ board.status }}
                </span>
                <button type="button" :disabled="loading" @click="reconcile">
                    {{ loading ? '处理中…' : '检查源漂移' }}
                </button>
                <button type="button" @click="emit('close')">返回对话</button>
            </div>
        </header>

        <p v-if="error" class="board-error">{{ error }}</p>
        <p v-if="reconciledAt" class="board-notice">
            已完成一轮源指纹检查。已存在章节不会被自动全量重写。
        </p>

        <section v-if="board" class="board-body">
            <article class="board-summary">
                <div>
                    <span>项目目的</span>
                    <p>{{ board.purpose || '尚未形成项目目的摘要。' }}</p>
                </div>
                <div class="board-health" :class="{ stale }">
                    <span>知识新鲜度</span>
                    <strong>{{ stale ? '需要复核' : '已对账' }}</strong>
                    <small>最后验证 {{ time(board.lastVerifiedAt) }}</small>
                </div>
            </article>

            <div class="board-grid">
                <article
                    v-for="section in sections"
                    :key="section.title"
                    class="board-section"
                    :class="section.tone"
                >
                    <h3>{{ section.title }}</h3>
                    <ul v-if="section.items.length">
                        <li v-for="(item, index) in section.items" :key="`${section.title}:${index}`">
                            {{ item }}
                        </li>
                    </ul>
                    <p v-else class="board-muted">暂无内容</p>
                </article>
            </div>

            <article class="board-evidence">
                <h3>证据与源指纹</h3>
                <div class="board-fingerprint">
                    <code>{{ board.sourceFingerprint }}</code>
                    <span>更新于 {{ time(board.updatedAt) }}</span>
                </div>
                <ul>
                    <li
                        v-for="evidence in board.evidenceRefs.slice(-30).reverse()"
                        :key="evidence.ref"
                    >
                        <span>{{ evidence.kind }}</span>
                        <code>{{ evidence.ref }}</code>
                        <small>{{ evidence.note || time(evidence.verifiedAt) }}</small>
                    </li>
                </ul>
                <p v-if="!board.evidenceRefs.length" class="board-muted">
                    暂无证据引用；执行项目会话后会写入 Goal 证据。
                </p>
            </article>
        </section>

        <div v-else-if="!loading && !error" class="board-empty">
            请先选择一个工作区。黑板会从当前代码、包信息、README 和执行轨迹中建立项目知识。
        </div>
    </section>
</template>

<style scoped>
.board-page {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    padding: 12px 16px 16px;
    gap: 10px;
    overflow: hidden;
}
.board-head,
.board-title,
.board-actions,
.board-summary,
.board-fingerprint {
    display: flex;
    align-items: center;
}
.board-head {
    justify-content: space-between;
    gap: 12px;
}
.board-title,
.board-actions {
    gap: 8px;
}
.board-title span,
.board-version,
.board-fingerprint,
.board-muted,
.board-evidence small,
.board-health small {
    color: var(--fg-tertiary);
    font-size: 11px;
}
.board-actions button {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
    color: var(--fg);
    padding: 5px 10px;
    font-size: 12px;
    cursor: pointer;
}
.board-actions button:hover {
    background: var(--bg-hover);
}
.board-error,
.board-notice {
    margin: 0;
    font-size: 12px;
}
.board-error {
    color: var(--error);
}
.board-notice {
    color: var(--ok);
}
.board-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.board-summary {
    align-items: stretch;
    gap: 10px;
}
.board-summary > div {
    flex: 1;
    padding: 12px;
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-md);
    background: var(--bg-panel);
}
.board-summary span,
.board-section h3,
.board-evidence h3 {
    font-size: 11px;
    font-weight: 600;
    color: var(--fg-secondary);
}
.board-summary p {
    margin: 8px 0 0;
    color: var(--fg);
    font-size: 13px;
    line-height: 1.6;
}
.board-health {
    max-width: 220px;
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.board-health strong {
    color: var(--ok);
    font-size: 15px;
}
.board-health.stale strong {
    color: var(--warn);
}
.board-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
}
.board-section,
.board-evidence {
    min-width: 0;
    padding: 10px;
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
}
.board-section.warn {
    border-color: color-mix(in srgb, var(--warn) 45%, var(--border-soft));
}
.board-section h3,
.board-evidence h3 {
    margin: 0 0 7px;
}
.board-section ul,
.board-evidence ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 5px;
}
.board-section li {
    color: var(--fg-secondary);
    font-size: 12px;
    line-height: 1.5;
    padding-left: 10px;
    position: relative;
}
.board-section li::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0.65em;
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: var(--fg-tertiary);
}
.board-muted {
    margin: 0;
}
.board-evidence {
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.board-fingerprint {
    gap: 10px;
}
.board-fingerprint code {
    color: var(--fg-secondary);
}
.board-evidence li {
    display: grid;
    grid-template-columns: 54px minmax(0, 1fr) auto;
    gap: 8px;
    align-items: baseline;
    font-size: 11px;
}
.board-evidence li > span {
    color: var(--accent);
}
.board-evidence li code {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg-secondary);
}
.board-empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--fg-tertiary);
    font-size: 13px;
    border: 1px dashed var(--border);
    border-radius: var(--radius-md);
}
@media (max-width: 1000px) {
    .board-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
}
@media (max-width: 680px) {
    .board-grid {
        grid-template-columns: 1fr;
    }
    .board-summary {
        flex-direction: column;
    }
}
</style>
