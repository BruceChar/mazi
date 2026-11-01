<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api.js';
import LineIcon from '../assets/LineIcon.vue';

const props = defineProps({
    rootGoalId: { type: String, default: '' },
});
const emit = defineEmits(['close']);

const events = ref([]);
const edges = ref([]);
const loading = ref(false);
const error = ref('');

const planEvents = computed(() =>
    events.value.filter(
        (event) => event.type === 'plan.revised' || event.type === 'replan.rejected',
    ),
);
const revisions = computed(() =>
    planEvents.value
        .filter((event) => event.type === 'plan.revised')
        .map((event) => ({
            ...event.payload,
            eventId: event.eventId,
            timestamp: event.timestamp,
        })),
);
const rejected = computed(() =>
    planEvents.value
        .filter((event) => event.type === 'replan.rejected')
        .map((event) => ({
            ...event.payload,
            eventId: event.eventId,
            timestamp: event.timestamp,
        })),
);

const delegationResults = computed(() => {
    const results = new Map();
    for (const event of events.value) {
        if (event.type !== 'delegation.completed') continue;
        const payload = event.payload ?? {};
        if (payload.childGoalId) results.set(payload.childGoalId, payload);
    }
    return results;
});

const treeRows = computed(() => {
    const children = new Map();
    const edgeByChild = new Map();
    for (const edge of edges.value) {
        edgeByChild.set(edge.childGoalId, edge);
        const list = children.get(edge.parentGoalId) ?? [];
        list.push(edge);
        children.set(edge.parentGoalId, list);
    }
    const rows = [];
    const seen = new Set();
    const visit = (goalId, depth) => {
        for (const edge of children.get(goalId) ?? []) {
            if (seen.has(edge.edgeId)) continue;
            seen.add(edge.edgeId);
            rows.push({
                ...edge,
                depth,
                result: delegationResults.value.get(edge.childGoalId),
            });
            visit(edge.childGoalId, depth + 1);
        }
    };
    if (props.rootGoalId) visit(props.rootGoalId, 0);
    for (const edge of edges.value) {
        if (seen.has(edge.edgeId)) continue;
        const parentKnown = edgeByChild.has(edge.parentGoalId);
        rows.push({
            ...edge,
            depth: parentKnown ? 1 : 0,
            orphan: !parentKnown,
            result: delegationResults.value.get(edge.childGoalId),
        });
    }
    return rows;
});

onMounted(load);
watch(
    () => props.rootGoalId,
    () => {
        void load();
    },
);

async function load() {
    if (!props.rootGoalId) {
        events.value = [];
        edges.value = [];
        return;
    }
    loading.value = true;
    error.value = '';
    try {
        const [eventData, delegationData] = await Promise.all([
            api(`/api/events/${encodeURIComponent(props.rootGoalId)}?limit=5000`),
            api(`/api/agent/sessions/${encodeURIComponent(props.rootGoalId)}/delegations`),
        ]);
        events.value = Array.isArray(eventData) ? eventData : [];
        edges.value = delegationData.edges ?? [];
    } catch (err) {
        error.value = String(err);
    } finally {
        loading.value = false;
    }
}

function time(value) {
    return value ? new Date(value).toLocaleString() : '-';
}

function shortId(value) {
    return value ? `${String(value).slice(0, 10)}…` : '-';
}

function budgetText(budget) {
    const parts = [];
    if (budget?.maxSteps !== undefined) parts.push(`${budget.maxSteps} steps`);
    if (budget?.maxCostUsd !== undefined) parts.push(`$${budget.maxCostUsd}`);
    return parts.join(' · ') || 'inherited';
}
</script>

<template>
    <section class="plan-page">
        <header class="plan-head">
            <div class="plan-title">
                <LineIcon name="thinking" :size="17" />
                <strong>Replan 与多 Agent</strong>
                <span>{{ rootGoalId || '未选择运行' }}</span>
            </div>
            <div class="plan-actions">
                <button type="button" :disabled="loading" @click="load">
                    {{ loading ? '加载中…' : '刷新' }}
                </button>
                <button type="button" @click="emit('close')">返回对话</button>
            </div>
        </header>

        <p v-if="error" class="plan-error">{{ error }}</p>
        <div v-if="rootGoalId" class="plan-layout">
            <main class="plan-main">
                <section class="plan-panel">
                    <div class="plan-section-head">
                        <h3>计划修订</h3>
                        <span>{{ revisions.length }} 次接受 · {{ rejected.length }} 次拒绝</span>
                    </div>
                    <div v-if="planEvents.length" class="plan-revisions">
                        <article v-for="revision in revisions" :key="revision.eventId">
                            <div class="plan-revision-head">
                                <strong>Revision {{ revision.revision }}</strong>
                                <span>{{ time(revision.timestamp) }}</span>
                            </div>
                            <p>{{ revision.reason }}</p>
                            <div class="plan-diff">
                                <span class="added">+ {{ revision.diff?.added?.join(' · ') || '无新增' }}</span>
                                <span class="removed">
                                    − {{ revision.diff?.removed?.join(' · ') || '无删除' }}
                                </span>
                                <span class="retained">
                                    = {{ revision.diff?.retained?.join(' · ') || '无保留项' }}
                                </span>
                            </div>
                            <details>
                                <summary>证据与摘要</summary>
                                <p v-for="item in revision.evidence ?? []" :key="item">{{ item }}</p>
                                <code>{{ revision.digest }}</code>
                            </details>
                        </article>
                        <article
                            v-for="item in rejected"
                            :key="item.eventId"
                            class="rejected"
                        >
                            <div class="plan-revision-head">
                                <strong>Replan 被拒绝</strong>
                                <span>{{ time(item.timestamp) }}</span>
                            </div>
                            <p>{{ item.rejected?.join(' · ') }}</p>
                        </article>
                    </div>
                    <p v-else class="plan-muted">
                        本次运行没有 Replan 事件。只有 Verifier/Executor 失败且宿主注入 ReplanPlanner
                        时才会产生修订。
                    </p>
                </section>

                <section class="plan-panel">
                    <div class="plan-section-head">
                        <h3>委派树</h3>
                        <span>{{ edges.length }} 条持久化 delegation edge</span>
                    </div>
                    <div v-if="treeRows.length" class="delegation-tree">
                        <article class="delegation-root">
                            <span class="tree-marker root"></span>
                            <strong>SuperAgent</strong>
                            <code>{{ shortId(rootGoalId) }}</code>
                        </article>
                        <article
                            v-for="edge in treeRows"
                            :key="edge.edgeId"
                            class="delegation-node"
                            :style="{ marginLeft: `${edge.depth * 24}px` }"
                        >
                            <span class="tree-marker"></span>
                            <div class="delegation-copy">
                                <strong>{{ edge.roleId }}</strong>
                                <code>{{ shortId(edge.childGoalId) }}</code>
                                <span>
                                    {{
                                        edge.result?.summary ||
                                        (edge.orphan
                                            ? 'parent edge 未在当前根下找到'
                                            : '等待结果事件')
                                    }}
                                </span>
                            </div>
                            <div class="delegation-meta">
                                <span>{{ edge.mode }}</span>
                                <span>{{ edge.permissionCeiling }}</span>
                                <span>{{ budgetText(edge.budgetShare) }}</span>
                                <strong :class="{ bad: edge.result && !edge.result.ok }">
                                    {{ edge.result ? (edge.result.ok ? 'OK' : 'FAILED') : 'RECORDED' }}
                                </strong>
                            </div>
                        </article>
                    </div>
                    <p v-else class="plan-muted">
                        本次运行没有子 Agent。主 Agent 可调用 delegate 工具扇出研究、执行或审查角色。
                    </p>
                </section>
            </main>

            <aside class="plan-side">
                <article class="plan-panel">
                    <h3>运行解释</h3>
                    <ul>
                        <li>Replan 保留已完成 Task，并重新校验冻结契约、工具、权限和预算。</li>
                        <li>子 Agent 权限与预算只能从父级单调递减。</li>
                        <li>父子关系持久化到 SQLite，事件写入可校验的审计链。</li>
                    </ul>
                </article>
                <article class="plan-panel">
                    <h3>事件索引</h3>
                    <div class="plan-event-index">
                        <span>plan.revised</span>
                        <strong>{{ revisions.length }}</strong>
                        <span>replan.rejected</span>
                        <strong>{{ rejected.length }}</strong>
                        <span>delegation edges</span>
                        <strong>{{ edges.length }}</strong>
                    </div>
                </article>
            </aside>
        </div>
        <div v-else-if="!loading" class="plan-empty">
            选择一个已执行的会话后查看计划修订和子 Agent 委托关系。
        </div>
    </section>
</template>

<style scoped>
.plan-page {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    padding: 12px 16px 16px;
    gap: 10px;
    overflow: hidden;
}
.plan-head,
.plan-title,
.plan-actions,
.plan-section-head,
.plan-revision-head,
.delegation-root,
.delegation-node,
.delegation-meta {
    display: flex;
    align-items: center;
}
.plan-head {
    justify-content: space-between;
}
.plan-title,
.plan-actions {
    gap: 8px;
}
.plan-title span,
.plan-section-head span,
.plan-revision-head span,
.plan-muted,
.plan-revisions details,
.delegation-copy span,
.delegation-meta span {
    color: var(--fg-tertiary);
    font-size: 10px;
}
.plan-actions button {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
    color: var(--fg);
    padding: 5px 10px;
    font-size: 12px;
    cursor: pointer;
}
.plan-actions button:hover {
    background: var(--bg-hover);
}
.plan-error {
    margin: 0;
    color: var(--error);
    font-size: 12px;
}
.plan-layout {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 260px;
    gap: 10px;
}
.plan-main,
.plan-side {
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.plan-panel {
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-md);
    background: var(--bg-panel);
    padding: 10px;
}
.plan-panel h3,
.plan-section-head h3 {
    margin: 0;
    font-size: 12px;
}
.plan-section-head {
    justify-content: space-between;
    margin-bottom: 8px;
}
.plan-revisions {
    display: flex;
    flex-direction: column;
    gap: 7px;
}
.plan-revisions article {
    padding: 9px;
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
    background: var(--bg);
}
.plan-revisions article.rejected {
    border-color: color-mix(in srgb, var(--error) 40%, var(--border-soft));
}
.plan-revision-head {
    justify-content: space-between;
}
.plan-revision-head strong {
    font-size: 11px;
}
.plan-revisions p {
    margin: 6px 0;
    color: var(--fg-secondary);
    font-size: 11px;
    line-height: 1.5;
}
.plan-diff {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
}
.plan-diff span {
    padding: 2px 6px;
    border-radius: 999px;
    font-size: 9px;
}
.plan-diff .added {
    color: var(--ok);
    background: var(--ok-soft);
}
.plan-diff .removed {
    color: var(--error);
    background: color-mix(in srgb, var(--error) 10%, transparent);
}
.plan-diff .retained {
    color: var(--fg-secondary);
    background: var(--bg-hover);
}
.plan-revisions details {
    margin-top: 7px;
    line-height: 1.5;
}
.plan-revisions code {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.plan-muted {
    margin: 0;
    padding: 18px;
    text-align: center;
    line-height: 1.55;
}
.delegation-tree {
    display: flex;
    flex-direction: column;
    gap: 5px;
}
.delegation-root,
.delegation-node {
    gap: 8px;
    min-width: 0;
    padding: 8px;
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
    background: var(--bg);
}
.delegation-root {
    background: var(--bg-hover);
}
.tree-marker {
    width: 8px;
    height: 8px;
    flex-shrink: 0;
    border: 2px solid var(--accent);
    border-radius: 50%;
}
.tree-marker.root {
    background: var(--accent);
}
.delegation-copy {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
}
.delegation-copy strong {
    font-size: 11px;
}
.delegation-copy code,
.delegation-root code {
    color: var(--fg-secondary);
    font-size: 10px;
}
.delegation-copy span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.delegation-meta {
    align-items: flex-end;
    flex-direction: column;
    gap: 2px;
}
.delegation-meta strong {
    color: var(--ok);
    font-size: 9px;
}
.delegation-meta strong.bad {
    color: var(--error);
}
.plan-side ul {
    margin: 8px 0 0;
    padding-left: 18px;
    color: var(--fg-secondary);
    font-size: 11px;
    line-height: 1.6;
}
.plan-event-index {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 6px;
    margin-top: 8px;
    font-size: 10px;
    color: var(--fg-tertiary);
}
.plan-event-index strong {
    color: var(--fg);
}
.plan-empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px dashed var(--border);
    border-radius: var(--radius-md);
    color: var(--fg-tertiary);
    font-size: 13px;
}
@media (max-width: 900px) {
    .plan-layout {
        grid-template-columns: 1fr;
        overflow-y: auto;
    }
    .plan-main,
    .plan-side {
        overflow: visible;
    }
}
</style>
