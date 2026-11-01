<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api.js';
import LineIcon from '../assets/LineIcon.vue';

const props = defineProps({
    rootGoalId: { type: String, default: '' },
    projectId: { type: String, default: '' },
    workspace: { type: String, default: '' },
});
const emit = defineEmits(['close']);

const input = ref('继续上次那个数据库迁移项目');
const tools = ref('fs.read, rg');
const riskLevel = ref('read-only');
const preview = ref(null);
const packs = ref([]);
const verifier = ref(null);
const roles = ref([]);
const events = ref([]);
const loading = ref(false);
const error = ref('');

const relevantEvents = computed(() => {
    const wanted = new Set([
        'superagent.decision',
        'prompt.pack.selected',
        'verification.completed',
    ]);
    return events.value.filter((event) => wanted.has(event.type));
});

const selectedPackIds = computed(() => new Set(preview.value?.promptPackIds ?? []));

onMounted(load);
watch(
    () => props.rootGoalId,
    () => {
        void loadEvents();
    },
);

async function load() {
    loading.value = true;
    error.value = '';
    try {
        const [packData, verifierData, roleData] = await Promise.all([
            api('/api/agent/prompt-packs'),
            api('/api/agent/verifier'),
            api('/api/agent/roles'),
        ]);
        packs.value = packData.packs ?? [];
        verifier.value = verifierData;
        roles.value = roleData.roles ?? [];
        await loadEvents();
        await runPreview();
    } catch (err) {
        error.value = String(err);
    } finally {
        loading.value = false;
    }
}

async function loadEvents() {
    if (!props.rootGoalId) {
        events.value = [];
        return;
    }
    try {
        events.value = await api(
            `/api/events/${encodeURIComponent(props.rootGoalId)}?limit=5000`,
        );
    } catch (err) {
        error.value = String(err);
    }
}

async function runPreview() {
    loading.value = true;
    error.value = '';
    try {
        const data = await api('/api/agent/preview', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                input: input.value,
                userId: 'local',
                ...(props.projectId ? { projectId: props.projectId } : {}),
                ...(props.workspace ? { workspace: props.workspace } : {}),
                tools: tools.value
                    .split(',')
                    .map((tool) => tool.trim())
                    .filter(Boolean),
                riskLevel: riskLevel.value,
            }),
        });
        preview.value = data.decision;
    } catch (err) {
        error.value = String(err);
    } finally {
        loading.value = false;
    }
}

function eventPayload(event) {
    return event.payload ?? {};
}

function eventSummary(event) {
    const payload = eventPayload(event);
    if (event.type === 'verification.completed') {
        return [
            payload.state,
            payload.failureCategory,
            payload.semanticJudgeId || 'mechanical',
        ]
            .filter(Boolean)
            .join(' · ');
    }
    if (event.type === 'prompt.pack.selected') {
        return Array.isArray(payload.selected)
            ? payload.selected.map((pack) => `${pack.id}@v${pack.version}`).join(', ')
            : '';
    }
    if (event.type === 'superagent.decision') {
        return [payload.taskKind, payload.riskLevel, payload.reason?.[0]]
            .filter(Boolean)
            .join(' · ');
    }
    return '';
}

function time(value) {
    return value ? new Date(value).toLocaleString() : '-';
}
</script>

<template>
    <section class="agent-page">
        <header class="agent-head">
            <div class="agent-title">
                <LineIcon name="cpu" :size="17" />
                <strong>Agent 编排</strong>
                <span>{{ rootGoalId || '未选择运行' }}</span>
            </div>
            <div class="agent-actions">
                <button type="button" :disabled="loading" @click="load">
                    {{ loading ? '加载中…' : '刷新' }}
                </button>
                <button type="button" @click="emit('close')">返回对话</button>
            </div>
        </header>

        <p v-if="error" class="agent-error">{{ error }}</p>

        <div class="agent-layout">
            <aside class="agent-side">
                <article class="agent-card">
                    <h3>SuperAgent Preview</h3>
                    <label>
                        输入
                        <textarea v-model="input" rows="4"></textarea>
                    </label>
                    <label>
                        工具
                        <input v-model="tools" placeholder="fs.read, rg" />
                    </label>
                    <label>
                        风险
                        <select v-model="riskLevel">
                            <option value="read-only">read-only</option>
                            <option value="workspace-write">workspace-write</option>
                            <option value="external">external</option>
                            <option value="irreversible">irreversible</option>
                        </select>
                    </label>
                    <button class="agent-primary" type="button" :disabled="loading" @click="runPreview">
                        计算最小匹配
                    </button>
                </article>

                <article class="agent-card">
                    <h3>Verifier</h3>
                    <div v-if="verifier" class="agent-verifier">
                        <strong>{{ verifier.id }}</strong>
                        <span>Semantic Judge: {{ verifier.semanticJudge ? '已注入' : '未注入' }}</span>
                        <p>独立验收；失败分类进入 failure ledger，不自行修改计划。</p>
                    </div>
                </article>

                <article class="agent-card">
                    <h3>Agent 角色</h3>
                    <div class="agent-role-list">
                        <div v-for="role in roles" :key="role.roleId">
                            <strong>{{ role.label }}</strong>
                            <span>{{ role.roleId }}</span>
                            <small>{{ role.tools?.join(', ') || 'inherit tools' }}</small>
                        </div>
                    </div>
                </article>
            </aside>

            <main class="agent-main">
                <section v-if="preview" class="agent-decision">
                    <div class="agent-decision-head">
                        <div>
                            <span>Task Kind</span>
                            <strong>{{ preview.taskKind }}</strong>
                        </div>
                        <div>
                            <span>Risk</span>
                            <strong>{{ preview.riskLevel }}</strong>
                        </div>
                        <div>
                            <span>Planner</span>
                            <strong>{{ preview.plannerId }}</strong>
                        </div>
                        <div>
                            <span>Blackboard</span>
                            <strong>{{ preview.blackboardRequired ? 'required' : 'optional' }}</strong>
                        </div>
                        <div>
                            <span>User Memory</span>
                            <strong>{{ preview.memoryPlan?.readUser ? 'read' : 'off' }}</strong>
                        </div>
                    </div>
                    <div class="agent-reasons">
                        <span v-for="reason in preview.reason" :key="reason">{{ reason }}</span>
                    </div>
                </section>

                <section class="agent-packs">
                    <div class="agent-section-head">
                        <h3>PromptPacks</h3>
                        <span>只注入命中的最小模块</span>
                    </div>
                    <div class="agent-pack-grid">
                        <article
                            v-for="pack in packs"
                            :key="pack.id"
                            class="agent-pack"
                            :class="{ selected: selectedPackIds.has(pack.id) }"
                        >
                            <div>
                                <strong>{{ pack.name }}</strong>
                                <span>{{ pack.id }} · v{{ pack.version }}</span>
                            </div>
                            <p>{{ pack.description }}</p>
                            <small>{{ pack.budgetTokens || '-' }} tokens</small>
                        </article>
                    </div>
                </section>

                <section class="agent-events">
                    <div class="agent-section-head">
                        <h3>运行事件</h3>
                        <span>{{ relevantEvents.length }} 条</span>
                    </div>
                    <div v-if="relevantEvents.length" class="agent-event-list">
                        <article v-for="event in relevantEvents" :key="event.eventId">
                            <span class="agent-event-type">{{ event.type }}</span>
                            <div>
                                <strong>{{ eventSummary(event) }}</strong>
                                <small>{{ time(event.timestamp) }}</small>
                            </div>
                            <pre>{{ JSON.stringify(eventPayload(event), null, 2) }}</pre>
                        </article>
                    </div>
                    <p v-else class="agent-muted">
                        选择一次已执行会话后，这里会显示 SuperAgent、PromptPack 和 Verifier 审计事件。
                    </p>
                </section>
            </main>
        </div>
    </section>
</template>

<style scoped>
.agent-page {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    padding: 12px 16px 16px;
    gap: 10px;
    overflow: hidden;
}
.agent-head,
.agent-title,
.agent-actions,
.agent-section-head,
.agent-decision-head {
    display: flex;
    align-items: center;
}
.agent-head {
    justify-content: space-between;
    gap: 12px;
}
.agent-title,
.agent-actions {
    gap: 8px;
}
.agent-title span,
.agent-section-head span,
.agent-pack span,
.agent-pack small,
.agent-role-list span,
.agent-role-list small,
.agent-event-list small,
.agent-muted,
.agent-event-list pre {
    color: var(--fg-tertiary);
    font-size: 10px;
}
.agent-actions button,
.agent-primary {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
    color: var(--fg);
    padding: 5px 10px;
    font-size: 12px;
    cursor: pointer;
}
.agent-actions button:hover {
    background: var(--bg-hover);
}
.agent-primary {
    background: var(--accent);
    border-color: transparent;
    color: #fff;
}
.agent-error {
    margin: 0;
    color: var(--error);
    font-size: 12px;
}
.agent-layout {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 290px minmax(0, 1fr);
    gap: 12px;
}
.agent-side {
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.agent-card,
.agent-decision,
.agent-packs,
.agent-events {
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-md);
    background: var(--bg-panel);
}
.agent-card {
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.agent-card h3,
.agent-section-head h3 {
    margin: 0;
    font-size: 12px;
}
.agent-card label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    color: var(--fg-secondary);
    font-size: 10px;
}
.agent-card input,
.agent-card textarea,
.agent-card select {
    box-sizing: border-box;
    width: 100%;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--fg);
    padding: 6px 8px;
    font: inherit;
    font-size: 11px;
    resize: vertical;
}
.agent-verifier {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 11px;
}
.agent-verifier span,
.agent-verifier p {
    margin: 0;
    color: var(--fg-tertiary);
    font-size: 10px;
    line-height: 1.5;
}
.agent-role-list {
    display: flex;
    flex-direction: column;
    gap: 5px;
}
.agent-role-list > div {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 2px 6px;
    font-size: 11px;
}
.agent-role-list small {
    grid-column: 1 / -1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.agent-main {
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.agent-decision {
    padding: 10px;
}
.agent-decision-head {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 6px;
}
.agent-decision-head div {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 8px;
    border-radius: var(--radius-sm);
    background: var(--bg-hover);
}
.agent-decision-head span {
    color: var(--fg-tertiary);
    font-size: 9px;
}
.agent-decision-head strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
}
.agent-reasons {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 8px;
}
.agent-reasons span {
    padding: 1px 6px;
    border: 1px solid var(--border-soft);
    border-radius: 999px;
    color: var(--fg-tertiary);
    font-size: 9px;
}
.agent-packs,
.agent-events {
    padding: 10px;
}
.agent-section-head {
    justify-content: space-between;
    margin-bottom: 8px;
}
.agent-pack-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 7px;
}
.agent-pack {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 8px;
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
    opacity: 0.62;
}
.agent-pack.selected {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 7%, transparent);
    opacity: 1;
}
.agent-pack > div {
    display: flex;
    flex-direction: column;
}
.agent-pack strong {
    font-size: 11px;
}
.agent-pack p {
    flex: 1;
    margin: 0;
    color: var(--fg-secondary);
    font-size: 10px;
    line-height: 1.45;
}
.agent-event-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.agent-event-list article {
    display: grid;
    grid-template-columns: 160px 1fr;
    gap: 6px 10px;
    padding: 8px;
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
}
.agent-event-type {
    color: var(--accent);
    font-size: 10px;
}
.agent-event-list article > div {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 11px;
}
.agent-event-list pre {
    grid-column: 1 / -1;
    max-height: 180px;
    margin: 0;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    background: var(--bg-code);
    border-radius: var(--radius-sm);
    padding: 7px;
}
.agent-muted {
    margin: 0;
    padding: 16px;
    text-align: center;
}
@media (max-width: 900px) {
    .agent-layout {
        grid-template-columns: 1fr;
        overflow-y: auto;
    }
    .agent-side {
        max-height: none;
    }
    .agent-decision-head {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
}
</style>
