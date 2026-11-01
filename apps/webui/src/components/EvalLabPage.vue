<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api.js';
import LineIcon from '../assets/LineIcon.vue';

const props = defineProps({
    models: { type: Array, default: () => [] },
    workspace: { type: String, default: '' },
    embedded: { type: Boolean, default: false },
});
const emit = defineEmits(['close']);

const tasks = ref([]);
const runs = ref([]);
const promptPacks = ref([]);
const selectedIds = ref([]);
const activeRun = ref(null);
const query = ref('');
const difficulty = ref('all');
const modelId = ref('');
const promptPackId = ref('');
const loading = ref(false);
const error = ref('');

const filteredTasks = computed(() => {
    const needle = query.value.trim().toLowerCase();
    return tasks.value.filter((task) => {
        if (difficulty.value !== 'all' && task.difficulty !== difficulty.value) return false;
        if (!needle) return true;
        return [task.id, task.title, task.category, task.input]
            .join(' ')
            .toLowerCase()
            .includes(needle);
    });
});

const selectedSet = computed(() => new Set(selectedIds.value));
const report = computed(() => activeRun.value?.report ?? null);
const failures = computed(
    () => report.value?.results?.filter((result) => result.success !== true) ?? [],
);
const difficultyRows = computed(() =>
    Object.entries(report.value?.byDifficulty ?? {}).map(([name, aggregate]) => ({
        name,
        ...aggregate,
    })),
);

watch(
    () => props.models,
    (models) => {
        if (!models.some((model) => model.id === modelId.value)) {
            modelId.value = models[0]?.id ?? '';
        }
    },
    { immediate: true },
);

onMounted(load);

async function load() {
    loading.value = true;
    error.value = '';
    try {
        const [taskData, runData, packData] = await Promise.all([
            api('/api/eval/tasks'),
            api('/api/eval/runs'),
            api('/api/agent/prompt-packs'),
        ]);
        tasks.value = taskData.tasks ?? [];
        runs.value = runData.runs ?? [];
        promptPacks.value = packData.packs ?? [];
        if (selectedIds.value.length === 0 && tasks.value[0]) {
            selectedIds.value = [tasks.value[0].id];
        }
    } catch (err) {
        error.value = String(err);
    } finally {
        loading.value = false;
    }
}

function toggleTask(taskId) {
    selectedIds.value = selectedSet.value.has(taskId)
        ? selectedIds.value.filter((id) => id !== taskId)
        : [...selectedIds.value, taskId];
}

function toggleVisible() {
    const visible = filteredTasks.value.map((task) => task.id);
    const allSelected = visible.length > 0 && visible.every((id) => selectedSet.value.has(id));
    selectedIds.value = allSelected
        ? selectedIds.value.filter((id) => !visible.includes(id))
        : [...new Set([...selectedIds.value, ...visible])];
}

async function runSelected() {
    if (selectedIds.value.length === 0 || loading.value) return;
    loading.value = true;
    error.value = '';
    try {
        activeRun.value = await api('/api/eval/runs', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                taskIds: selectedIds.value,
                ...(modelId.value ? { modelId: modelId.value } : {}),
                ...(promptPackId.value ? { promptPackId: promptPackId.value } : {}),
                ...(props.workspace ? { workspace: props.workspace } : {}),
            }),
        });
        runs.value = (await api('/api/eval/runs')).runs ?? [];
    } catch (err) {
        error.value = String(err);
        await loadRuns();
    } finally {
        loading.value = false;
    }
}

async function openRun(runId) {
    try {
        activeRun.value = await api(`/api/eval/runs/${encodeURIComponent(runId)}`);
    } catch (err) {
        error.value = String(err);
    }
}

async function loadRuns() {
    try {
        runs.value = (await api('/api/eval/runs')).runs ?? [];
    } catch {
        // Preserve the primary error from the failed run.
    }
}

function percent(value) {
    return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function duration(ms) {
    const value = Number(ms || 0);
    return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

function money(value) {
    return `$${Number(value || 0).toFixed(4)}`;
}

function time(value) {
    return value ? new Date(value).toLocaleString() : '-';
}

function statusTone(result) {
    return result.success ? 'ok' : 'bad';
}
</script>

<template>
    <section class="eval-page" :class="{ embedded }">
        <header v-if="!embedded" class="eval-head">
            <div class="eval-title">
                <LineIcon name="observation" :size="17" />
                <strong>Benchmark</strong>
                <span>P0 基线 · {{ tasks.length }} 个任务</span>
            </div>
            <div class="eval-actions">
                <button type="button" :disabled="loading" @click="load">
                    {{ loading ? '处理中…' : '刷新' }}
                </button>
                <button type="button" @click="emit('close')">返回对话</button>
            </div>
        </header>

        <p v-if="error" class="eval-error">{{ error }}</p>

        <div class="eval-layout">
            <aside class="eval-sidebar">
                <div class="eval-filters">
                    <input v-model="query" placeholder="搜索任务、类别…" />
                    <select v-model="difficulty">
                        <option value="all">全部难度</option>
                        <option value="simple">simple</option>
                        <option value="medium">medium</option>
                        <option value="hard">hard</option>
                        <option value="long-horizon">long-horizon</option>
                    </select>
                </div>
                <div class="eval-list-head">
                    <span>已选 {{ selectedIds.length }}</span>
                    <button type="button" @click="toggleVisible">切换当前列表</button>
                </div>
                <div class="eval-task-list">
                    <label
                        v-for="task in filteredTasks"
                        :key="task.id"
                        class="eval-task"
                        :class="{ selected: selectedSet.has(task.id) }"
                    >
                        <input
                            type="checkbox"
                            :checked="selectedSet.has(task.id)"
                            @change="toggleTask(task.id)"
                        />
                        <span class="eval-task-copy">
                            <strong>{{ task.title }}</strong>
                            <span>{{ task.id }} · {{ task.category }}</span>
                        </span>
                        <span class="eval-risk" :data-risk="task.risk">{{ task.risk }}</span>
                    </label>
                </div>
            </aside>

            <main class="eval-main">
                <section class="eval-runner">
                    <div class="eval-runner-fields">
                        <label>
                            模型
                            <select v-model="modelId">
                                <option value="">Provider 默认</option>
                                <option v-for="model in models" :key="model.id" :value="model.id">
                                    {{ model.label }} · {{ model.providerId }}
                                </option>
                            </select>
                        </label>
                        <label>
                            PromptPack
                            <select v-model="promptPackId">
                                <option value="">SuperAgent 自动匹配</option>
                                <option v-for="pack in promptPacks" :key="pack.id" :value="pack.id">
                                    {{ pack.name }} · {{ pack.id }}
                                </option>
                            </select>
                        </label>
                        <div class="eval-workspace">
                            <span>工作区</span>
                            <strong :title="workspace">{{ workspace || '服务端当前工作区' }}</strong>
                        </div>
                    </div>
                    <button
                        class="eval-run"
                        type="button"
                        :disabled="loading || selectedIds.length === 0"
                        @click="runSelected"
                    >
                        <LineIcon name="play" :size="15" />
                        {{ loading ? '评测中…' : `运行已选 ${selectedIds.length} 项` }}
                    </button>
                </section>

                <section v-if="report" class="eval-report">
                    <div class="eval-metrics">
                        <div>
                            <strong>{{ percent(report.overall.successRate) }}</strong>
                            <span>任务成功率</span>
                        </div>
                        <div>
                            <strong>{{ percent(report.overall.toolCallAccuracy) }}</strong>
                            <span>工具准确率</span>
                        </div>
                        <div>
                            <strong>{{ percent(report.overall.interventionRate) }}</strong>
                            <span>人工接管率</span>
                        </div>
                        <div>
                            <strong>{{ report.overall.averageSteps.toFixed(1) }}</strong>
                            <span>平均步数</span>
                        </div>
                        <div>
                            <strong>{{ duration(report.overall.p95LatencyMs) }}</strong>
                            <span>P95 延迟</span>
                        </div>
                        <div>
                            <strong>{{ Math.round(report.overall.averageTokens) }}</strong>
                            <span>平均 Token</span>
                        </div>
                        <div>
                            <strong>{{ money(report.overall.averageCostUsd) }}</strong>
                            <span>平均成本</span>
                        </div>
                    </div>

                    <div class="eval-grid">
                        <article class="eval-panel">
                            <h3>分难度结果</h3>
                            <table>
                                <thead>
                                    <tr>
                                        <th>难度</th>
                                        <th>成功</th>
                                        <th>工具准确率</th>
                                        <th>P95</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr v-for="row in difficultyRows" :key="row.name">
                                        <td>{{ row.name }}</td>
                                        <td>{{ row.successes }}/{{ row.tasks }}</td>
                                        <td>{{ percent(row.toolCallAccuracy) }}</td>
                                        <td>{{ duration(row.p95LatencyMs) }}</td>
                                    </tr>
                                </tbody>
                            </table>
                        </article>

                        <article class="eval-panel">
                            <h3>失败归因</h3>
                            <div v-if="failures.length" class="eval-failures">
                                <div v-for="result in failures" :key="result.task.id">
                                    <strong>{{ result.task.title }}</strong>
                                    <span>{{ result.failureCategory || 'unclassified' }}</span>
                                    <p v-if="result.failureEvidence?.length">
                                        {{ result.failureEvidence.join(' · ') }}
                                    </p>
                                </div>
                            </div>
                            <p v-else class="eval-muted">本次运行没有失败任务。</p>
                        </article>
                    </div>

                    <article class="eval-panel eval-results">
                        <h3>任务明细</h3>
                        <table>
                            <thead>
                                <tr>
                                    <th>状态</th>
                                    <th>任务</th>
                                    <th>工具</th>
                                    <th>步数</th>
                                    <th>Token</th>
                                    <th>延迟</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-for="result in report.results" :key="result.task.id">
                                    <td>
                                        <span class="eval-status" :class="statusTone(result)">
                                            {{ result.success ? 'PASS' : 'FAIL' }}
                                        </span>
                                    </td>
                                    <td>
                                        <strong>{{ result.task.title }}</strong>
                                        <span>{{ result.task.id }}</span>
                                    </td>
                                    <td>{{ percent(result.toolCallAccuracy) }}</td>
                                    <td>{{ result.observation.steps }}</td>
                                    <td>{{ result.totalTokens }}</td>
                                    <td>{{ duration(result.observation.latencyMs) }}</td>
                                </tr>
                            </tbody>
                        </table>
                    </article>
                </section>

                <section v-else class="eval-empty">
                    <LineIcon name="observation" :size="30" />
                    <strong>选择一个或多个任务后运行</strong>
                    <p>报告会展示成功率、工具准确率、接管率、P50/P95、Token、成本和失败归因。</p>
                </section>

                <section class="eval-history">
                    <div class="eval-list-head">
                        <span>最近运行</span>
                        <span>{{ runs.length }} 次</span>
                    </div>
                    <button
                        v-for="run in runs.slice(0, 8)"
                        :key="run.runId"
                        type="button"
                        class="eval-run-row"
                        :class="{ active: run.runId === activeRun?.runId }"
                        @click="openRun(run.runId)"
                    >
                        <span class="eval-status" :class="run.status === 'completed' ? 'ok' : 'bad'">
                            {{ run.status }}
                        </span>
                        <span>{{ time(run.startedAt) }}</span>
                        <span>{{ run.taskIds.length }} 任务</span>
                        <span>
                            {{ run.report ? percent(run.report.overall.successRate) : '-' }}
                        </span>
                        <code>{{ run.runId.slice(0, 8) }}</code>
                    </button>
                    <p v-if="!runs.length" class="eval-muted">尚无评测运行。</p>
                </section>
            </main>
        </div>
    </section>
</template>

<style scoped>
.eval-page {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    padding: 12px 16px 16px;
    gap: 10px;
    overflow: hidden;
}
.eval-page.embedded {
    padding: 10px 16px 16px;
}
.eval-head,
.eval-actions,
.eval-title,
.eval-list-head,
.eval-runner,
.eval-run-row {
    display: flex;
    align-items: center;
}
.eval-head {
    justify-content: space-between;
    gap: 12px;
}
.eval-title {
    gap: 8px;
}
.eval-title span,
.eval-list-head,
.eval-muted,
.eval-task-copy span,
.eval-results td:nth-child(2) span,
.eval-workspace span {
    color: var(--fg-tertiary);
    font-size: 11px;
}
.eval-actions {
    gap: 8px;
}
.eval-actions button,
.eval-list-head button,
.eval-run {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
    color: var(--fg);
    padding: 5px 10px;
    font-size: 12px;
    cursor: pointer;
}
.eval-actions button:hover,
.eval-list-head button:hover {
    background: var(--bg-hover);
}
.eval-error {
    margin: 0;
    color: var(--error);
    font-size: 12px;
}
.eval-layout {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(270px, 340px) minmax(0, 1fr);
    gap: 12px;
}
.eval-sidebar,
.eval-main {
    min-height: 0;
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-md);
    background: var(--bg-panel);
}
.eval-sidebar {
    display: flex;
    flex-direction: column;
    overflow: hidden;
}
.eval-filters {
    padding: 10px;
    display: grid;
    gap: 6px;
    border-bottom: 1px solid var(--border-soft);
}
.eval-filters input,
.eval-filters select,
.eval-runner select {
    box-sizing: border-box;
    width: 100%;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--fg);
    padding: 6px 8px;
    font: inherit;
    font-size: 12px;
}
.eval-list-head {
    justify-content: space-between;
    padding: 8px 10px;
    font-weight: 600;
}
.eval-list-head button {
    padding: 2px 7px;
    font-size: 10px;
}
.eval-task-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 6px 8px;
}
.eval-task {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
    padding: 8px;
    border-radius: var(--radius-sm);
    cursor: pointer;
}
.eval-task:hover,
.eval-task.selected {
    background: var(--bg-hover);
}
.eval-task-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
}
.eval-task-copy strong,
.eval-results td strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
}
.eval-risk {
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 1px 6px;
    font-size: 9px;
    color: var(--fg-tertiary);
}
.eval-risk[data-risk='workspace-write'],
.eval-risk[data-risk='external'],
.eval-risk[data-risk='irreversible'] {
    color: var(--warn);
    border-color: var(--warn);
}
.eval-main {
    overflow-y: auto;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.eval-runner {
    justify-content: space-between;
    gap: 12px;
    padding: 10px;
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
    background: var(--bg-hover);
}
.eval-runner-fields {
    flex: 1;
    display: grid;
    grid-template-columns: minmax(150px, 1fr) minmax(170px, 1fr) minmax(120px, 0.8fr);
    gap: 8px;
}
.eval-runner-fields label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 11px;
    color: var(--fg-secondary);
}
.eval-workspace {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 11px;
}
.eval-workspace strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11px;
}
.eval-run {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    background: var(--accent);
    color: #fff;
    border-color: transparent;
    padding: 7px 12px;
}
.eval-run:disabled,
.eval-actions button:disabled {
    opacity: 0.55;
    cursor: default;
}
.eval-report {
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.eval-metrics {
    display: grid;
    grid-template-columns: repeat(7, minmax(80px, 1fr));
    gap: 6px;
}
.eval-metrics div {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 9px;
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
}
.eval-metrics strong {
    font-size: 17px;
    font-variant-numeric: tabular-nums;
}
.eval-metrics span {
    font-size: 10px;
    color: var(--fg-tertiary);
}
.eval-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
}
.eval-panel {
    min-width: 0;
    padding: 10px;
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
}
.eval-panel h3 {
    margin: 0 0 8px;
    font-size: 12px;
}
.eval-panel table {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
}
.eval-panel th,
.eval-panel td {
    text-align: left;
    padding: 5px 6px;
    border-bottom: 1px solid var(--border-soft);
}
.eval-panel th {
    color: var(--fg-tertiary);
    font-weight: 500;
}
.eval-results td:nth-child(2) {
    display: flex;
    flex-direction: column;
    gap: 1px;
}
.eval-status {
    display: inline-flex;
    justify-content: center;
    min-width: 42px;
    padding: 1px 5px;
    border-radius: 999px;
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
}
.eval-status.ok {
    background: var(--ok-soft);
    color: var(--ok);
}
.eval-status.bad {
    background: color-mix(in srgb, var(--error) 14%, transparent);
    color: var(--error);
}
.eval-failures {
    display: flex;
    flex-direction: column;
    gap: 7px;
}
.eval-failures > div {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 3px 8px;
    font-size: 11px;
}
.eval-failures p {
    grid-column: 1 / -1;
    margin: 0;
    color: var(--fg-tertiary);
}
.eval-empty {
    min-height: 210px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 7px;
    border: 1px dashed var(--border);
    border-radius: var(--radius-md);
    color: var(--fg-tertiary);
}
.eval-empty strong {
    color: var(--fg-secondary);
}
.eval-empty p {
    margin: 0;
    max-width: 520px;
    text-align: center;
    font-size: 12px;
}
.eval-history {
    border-top: 1px solid var(--border-soft);
    padding-top: 4px;
}
.eval-run-row {
    width: 100%;
    display: grid;
    grid-template-columns: 76px 1.4fr 0.7fr 0.7fr 72px;
    gap: 8px;
    border: none;
    background: transparent;
    color: var(--fg-secondary);
    padding: 6px 8px;
    font-size: 11px;
    text-align: left;
    cursor: pointer;
}
.eval-run-row:hover,
.eval-run-row.active {
    background: var(--bg-hover);
}
.eval-run-row code {
    color: var(--fg-tertiary);
}
@media (max-width: 1000px) {
    .eval-layout {
        grid-template-columns: 1fr;
        overflow-y: auto;
    }
    .eval-sidebar {
        max-height: 320px;
    }
    .eval-metrics {
        grid-template-columns: repeat(4, minmax(80px, 1fr));
    }
    .eval-runner {
        align-items: stretch;
        flex-direction: column;
    }
    .eval-runner-fields,
    .eval-grid {
        grid-template-columns: 1fr;
    }
}
</style>
