<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import LineIcon from '../assets/LineIcon.vue';

const emit = defineEmits(['close', 'open-trace']);

const records = ref([]);
const loading = ref(false);
const error = ref('');
const projectFilter = ref('all');
const sourceFilter = ref('all');
const query = ref('');
const selectedId = ref('');

const filtered = computed(() => {
    const needle = query.value.trim().toLowerCase();
    return records.value.filter((record) => {
        if (projectFilter.value !== 'all' && projectKey(record) !== projectFilter.value) {
            return false;
        }
        if (sourceFilter.value !== 'all' && record.source !== sourceFilter.value) return false;
        if (!needle) return true;
        return [record.title, record.rootGoalId, record.projectId, record.modelId]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .includes(needle);
    });
});

const selected = computed(
    () => filtered.value.find((record) => record.rootGoalId === selectedId.value) ?? null,
);

const projects = computed(() => {
    const values = new Map();
    for (const record of records.value) {
        const key = projectKey(record);
        const current = values.get(key) ?? {
            key,
            label: projectLabel(record),
            sessions: 0,
            successes: 0,
            costUsd: 0,
            totalTokens: 0,
        };
        current.sessions += 1;
        current.successes += record.success ? 1 : 0;
        current.costUsd += record.costUsd ?? 0;
        current.totalTokens += record.totalTokens ?? 0;
        values.set(key, current);
    }
    return [...values.values()].sort((left, right) => right.sessions - left.sessions);
});

const summary = computed(() => aggregate(filtered.value));
const failures = computed(() => {
    const counts = new Map();
    for (const record of filtered.value) {
        if (record.failureCategory) {
            counts.set(record.failureCategory, (counts.get(record.failureCategory) ?? 0) + 1);
        }
    }
    return [...counts.entries()].sort((left, right) => right[1] - left[1]);
});

onMounted(refreshAll);

async function refreshAll() {
    await backfill();
    await load();
}

async function backfill() {
    try {
        await api('/api/eval/sessions/reconcile', { method: 'POST' });
    } catch {
        // Existing evaluations remain usable even if an old Goal tree cannot be scanned.
    }
}

async function load() {
    loading.value = true;
    error.value = '';
    try {
        const data = await api('/api/eval/sessions?limit=500');
        records.value = data.sessions ?? [];
        if (!records.value.some((record) => record.rootGoalId === selectedId.value)) {
            selectedId.value = records.value[0]?.rootGoalId ?? '';
        }
    } catch (err) {
        error.value = String(err);
    } finally {
        loading.value = false;
    }
}

function aggregate(items) {
    const sessions = items.length;
    const successes = items.filter((record) => record.success).length;
    const interventions = items.reduce((sum, record) => sum + record.interventions, 0);
    const latencies = items.map((record) => record.latencyMs).sort((left, right) => left - right);
    const p95 = latencies.length
        ? latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)]
        : 0;
    return {
        sessions,
        successes,
        successRate: sessions ? successes / sessions : 0,
        interventionRate: sessions ? interventions / sessions : 0,
        averageSteps: average(items.map((record) => record.steps)),
        averageLatencyMs: average(latencies),
        p95LatencyMs: p95,
        averageTokens: average(items.map((record) => record.totalTokens)),
        totalCostUsd: items.reduce((sum, record) => sum + record.costUsd, 0),
    };
}

function average(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function projectKey(record) {
    return record.projectId || '__unassigned__';
}

function projectLabel(record) {
    if (!record.projectId) return '未归属项目';
    if (record.workspace) return record.workspace.replace(/\/+$/, '').split('/').at(-1);
    return record.projectId.slice(0, 10);
}

function percent(value) {
    return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function duration(value) {
    const ms = Number(value || 0);
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function money(value) {
    return `$${Number(value || 0).toFixed(4)}`;
}

function time(value) {
    return value ? new Date(value).toLocaleString() : '-';
}

function statusLabel(record) {
    return {
        success: '成功',
        failed: '失败',
        aborted: '中止',
        unverified: '未判定',
    }[record.status] ?? record.status;
}
</script>

<template>
    <section class="eval-dashboard">
        <header class="eval-head">
            <div class="eval-title">
                <LineIcon name="observation" :size="17" />
                <strong>评测</strong>
                <span>从 Trace 派生 · {{ records.length }} 次真实运行</span>
            </div>
            <div class="eval-actions">
                <button type="button" :disabled="loading" @click="refreshAll">
                    {{ loading ? '加载中…' : '刷新' }}
                </button>
                <button type="button" @click="emit('close')">返回对话</button>
            </div>
        </header>

        <p v-if="error" class="eval-error">{{ error }}</p>

        <div class="eval-toolbar">
            <input v-model="query" placeholder="搜索会话、项目、模型…" />
            <select v-model="projectFilter">
                <option value="all">全部项目</option>
                <option v-for="project in projects" :key="project.key" :value="project.key">
                    {{ project.label }} · {{ project.sessions }}
                </option>
            </select>
            <select v-model="sourceFilter">
                <option value="all">全部来源</option>
                <option value="session">普通会话</option>
                <option value="ab">AB 实验</option>
            </select>
        </div>

        <section class="eval-kpis">
            <div><strong>{{ summary.sessions }}</strong><span>会话</span></div>
            <div><strong>{{ percent(summary.successRate) }}</strong><span>成功率</span></div>
            <div><strong>{{ percent(summary.interventionRate) }}</strong><span>接管率</span></div>
            <div><strong>{{ summary.averageSteps.toFixed(1) }}</strong><span>平均步数</span></div>
            <div><strong>{{ duration(summary.p95LatencyMs) }}</strong><span>P95 延迟</span></div>
            <div><strong>{{ Math.round(summary.averageTokens) }}</strong><span>平均 Token</span></div>
            <div><strong>{{ money(summary.totalCostUsd) }}</strong><span>总成本</span></div>
        </section>

        <div class="eval-layout">
            <main class="eval-main">
                <section class="eval-projects">
                    <div class="eval-section-head">
                        <h3>项目</h3>
                        <span>按项目聚合真实会话</span>
                    </div>
                    <div class="eval-project-grid">
                        <button
                            v-for="project in projects"
                            :key="project.key"
                            type="button"
                            :class="{ active: projectFilter === project.key }"
                            @click="projectFilter = projectFilter === project.key ? 'all' : project.key"
                        >
                            <strong>{{ project.label }}</strong>
                            <span>{{ project.sessions }} 次 · {{ percent(project.successes / project.sessions) }}</span>
                            <small>{{ money(project.costUsd) }} · {{ Math.round(project.totalTokens) }} tok</small>
                        </button>
                        <p v-if="!projects.length" class="eval-muted">暂无项目评测数据。</p>
                    </div>
                </section>

                <section class="eval-sessions">
                    <div class="eval-section-head">
                        <h3>会话</h3>
                        <span>{{ filtered.length }} 条</span>
                    </div>
                    <button
                        v-for="record in filtered"
                        :key="record.rootGoalId"
                        type="button"
                        class="eval-session-row"
                        :class="{ active: record.rootGoalId === selectedId }"
                        @click="selectedId = record.rootGoalId"
                    >
                        <span class="eval-status" :class="record.status">{{ statusLabel(record) }}</span>
                        <span class="eval-session-copy">
                            <strong>{{ record.title }}</strong>
                            <small>
                                {{ time(record.completedAt) }} · {{ projectLabel(record) }} ·
                                {{ record.source === 'ab' ? `AB ${record.arm || ''}` : '会话' }}
                            </small>
                        </span>
                        <span>{{ record.steps }} 步</span>
                        <span>{{ record.totalTokens }} tok</span>
                        <span>{{ duration(record.latencyMs) }}</span>
                    </button>
                    <p v-if="!filtered.length && !loading" class="eval-muted">
                        暂无评测记录。真实会话完成后会自动出现在这里。
                    </p>
                </section>
            </main>

            <aside class="eval-detail">
                <template v-if="selected">
                    <div class="eval-section-head">
                        <h3>会话详情</h3>
                        <button
                            v-if="selected.source === 'session'"
                            type="button"
                            @click="emit('open-trace', selected)"
                        >
                            打开 Trace
                        </button>
                    </div>
                    <h4>{{ selected.title }}</h4>
                    <p class="eval-session-id">{{ selected.rootGoalId }}</p>
                    <div class="eval-detail-grid">
                        <div><span>状态</span><strong>{{ statusLabel(selected) }}</strong></div>
                        <div><span>任务</span><strong>{{ selected.tasks.succeeded }}/{{ selected.tasks.total }}</strong></div>
                        <div><span>工具成功率</span><strong>{{ percent(selected.tools.successRate) }}</strong></div>
                        <div><span>重复调用</span><strong>{{ selected.tools.duplicateCalls }}</strong></div>
                        <div><span>审批</span><strong>{{ selected.interventions }}</strong></div>
                        <div><span>拒绝审批</span><strong>{{ selected.approvalsDenied }}</strong></div>
                        <div><span>Replan</span><strong>{{ selected.replans }}</strong></div>
                        <div><span>缓存 Token</span><strong>{{ selected.cachedInputTokens }}</strong></div>
                    </div>
                    <div class="eval-detail-line">
                        <span>模型</span><code>{{ selected.modelId || 'default' }}</code>
                    </div>
                    <div class="eval-detail-line">
                        <span>PromptPack</span>
                        <code>{{ selected.promptPackIds.join(', ') || 'auto' }}</code>
                    </div>
                    <div class="eval-detail-line">
                        <span>验收</span>
                        <code>{{ selected.acceptance.passed }} passed / {{ selected.acceptance.failed }} failed / {{ selected.acceptance.evaluated }} evaluated</code>
                    </div>
                    <div v-if="selected.failureCategory" class="eval-failure">
                        <strong>{{ selected.failureCategory }}</strong>
                        <p v-for="evidence in selected.failureEvidence" :key="evidence">{{ evidence }}</p>
                    </div>
                </template>
                <p v-else class="eval-muted">选择左侧会话查看派生指标。</p>

                <section class="eval-failure-summary">
                    <div class="eval-section-head">
                        <h3>失败分布</h3>
                        <span>{{ failures.reduce((sum, item) => sum + item[1], 0) }} 次</span>
                    </div>
                    <div v-for="[category, count] in failures" :key="category" class="eval-failure-row">
                        <span>{{ category }}</span>
                        <strong>{{ count }}</strong>
                    </div>
                    <p v-if="!failures.length" class="eval-muted">暂无失败归因。</p>
                </section>
            </aside>
        </div>
    </section>
</template>

<style scoped>
.eval-dashboard {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    padding: 12px 16px 16px;
    gap: 10px;
    overflow: hidden;
}
.eval-head,
.eval-title,
.eval-actions,
.eval-toolbar,
.eval-section-head,
.eval-session-row {
    display: flex;
    align-items: center;
}
.eval-head {
    justify-content: space-between;
}
.eval-title,
.eval-actions {
    gap: 8px;
}
.eval-title span,
.eval-section-head span,
.eval-session-copy small,
.eval-project-grid span,
.eval-project-grid small,
.eval-session-id,
.eval-muted {
    color: var(--fg-tertiary);
    font-size: 11px;
}
.eval-actions button,
.eval-section-head button {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
    color: var(--fg);
    padding: 5px 10px;
    font-size: 12px;
    cursor: pointer;
}
.eval-error {
    margin: 0;
    color: var(--error);
    font-size: 12px;
}
.eval-toolbar {
    gap: 8px;
}
.eval-toolbar input,
.eval-toolbar select {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--fg);
    padding: 6px 8px;
    font: inherit;
    font-size: 12px;
}
.eval-toolbar input {
    flex: 1;
}
.eval-kpis {
    display: grid;
    grid-template-columns: repeat(7, minmax(80px, 1fr));
    gap: 6px;
}
.eval-kpis div {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 9px;
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
}
.eval-kpis strong {
    font-size: 17px;
    font-variant-numeric: tabular-nums;
}
.eval-kpis span {
    color: var(--fg-tertiary);
    font-size: 10px;
}
.eval-layout {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 300px;
    gap: 10px;
}
.eval-main,
.eval-detail {
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.eval-projects,
.eval-sessions,
.eval-detail {
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-md);
    background: var(--bg-panel);
    padding: 10px;
}
.eval-section-head {
    justify-content: space-between;
    margin-bottom: 8px;
}
.eval-section-head h3 {
    margin: 0;
    font-size: 12px;
}
.eval-project-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 6px;
}
.eval-project-grid button {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--fg);
    padding: 8px;
    text-align: left;
    cursor: pointer;
}
.eval-project-grid button:hover,
.eval-project-grid button.active {
    border-color: var(--accent);
    background: var(--bg-hover);
}
.eval-session-row {
    width: 100%;
    display: grid;
    grid-template-columns: 58px minmax(0, 1fr) 58px 70px 64px;
    gap: 7px;
    border: none;
    border-bottom: 1px solid var(--border-soft);
    background: transparent;
    color: var(--fg-secondary);
    padding: 7px 5px;
    text-align: left;
    font-size: 10px;
    cursor: pointer;
}
.eval-session-row:hover,
.eval-session-row.active {
    background: var(--bg-hover);
}
.eval-session-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
}
.eval-session-copy strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg);
    font-size: 11px;
}
.eval-status {
    display: inline-flex;
    justify-content: center;
    border-radius: 999px;
    padding: 1px 5px;
    font-size: 9px;
    font-weight: 600;
}
.eval-status.success {
    color: var(--ok);
    background: var(--ok-soft);
}
.eval-status.failed {
    color: var(--error);
    background: var(--error-soft);
}
.eval-status.aborted,
.eval-status.unverified {
    color: var(--warn);
    background: color-mix(in srgb, var(--warn) 12%, transparent);
}
.eval-detail h4 {
    margin: 0;
    font-size: 13px;
}
.eval-session-id {
    margin: 3px 0 9px;
    overflow-wrap: anywhere;
}
.eval-detail-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 5px;
    margin-bottom: 9px;
}
.eval-detail-grid div {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px;
    background: var(--bg-hover);
    border-radius: var(--radius-sm);
}
.eval-detail-grid span,
.eval-detail-line span {
    color: var(--fg-tertiary);
    font-size: 9px;
}
.eval-detail-grid strong {
    font-size: 11px;
}
.eval-detail-line {
    display: grid;
    grid-template-columns: 70px minmax(0, 1fr);
    gap: 5px;
    padding: 5px 0;
    border-top: 1px solid var(--border-soft);
}
.eval-detail-line code {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg-secondary);
    font-size: 9px;
}
.eval-failure {
    margin-top: 8px;
    padding: 7px;
    border: 1px solid color-mix(in srgb, var(--error) 30%, var(--border-soft));
    border-radius: var(--radius-sm);
    font-size: 10px;
}
.eval-failure p {
    margin: 5px 0 0;
    color: var(--fg-tertiary);
}
.eval-failure-summary {
    border-top: 1px solid var(--border-soft);
    margin-top: 8px;
    padding-top: 8px;
}
.eval-failure-row {
    display: flex;
    justify-content: space-between;
    padding: 4px 0;
    border-bottom: 1px solid var(--border-soft);
    font-size: 10px;
}
@media (max-width: 1000px) {
    .eval-layout {
        grid-template-columns: 1fr;
        overflow-y: auto;
    }
    .eval-kpis {
        grid-template-columns: repeat(4, minmax(80px, 1fr));
    }
}
</style>
