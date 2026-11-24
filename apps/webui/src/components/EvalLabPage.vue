<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { api, API_BASE } from '../api.js';
import LineIcon from '../assets/LineIcon.vue';
import {
    ARM_EVENT_TYPES,
    applyArmEvent,
    armStreamText,
    initialArmLive,
} from '../scripts/arm-live.js';
import { respondApproval } from '../scripts/store.js';

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
const starting = ref(false);
const stopBusy = ref(false);
const resumeBusy = ref(false);
const error = ref('');

/** taskId → ArmLive：每个评测任务的实时投影（复用 AB 单臂的事件归约）。 */
const taskLive = reactive({});
const sources = new Map();
let pollTimer = null;
let clockTimer = null;
const nowTick = ref(Date.now());

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

const running = computed(() => activeRun.value?.status === 'running');
const activeProgress = computed(() => activeRun.value?.progress ?? []);
const doneCount = computed(
    () => activeProgress.value.filter((item) => item.status === 'completed').length,
);
const liveCount = computed(
    () =>
        activeProgress.value.filter(
            (item) => item.status === 'running' || item.status === 'stopping',
        ).length,
);
const stoppedCount = computed(
    () => activeProgress.value.filter((item) => item.status === 'stopped').length,
);
const resumable = computed(() =>
    activeProgress.value.filter(
        (item) => item.status === 'stopped' || item.status === 'pending',
    ),
);
const canResume = computed(
    () => activeRun.value?.status === 'aborted' && resumable.value.length > 0,
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

onMounted(() => {
    clockTimer = setInterval(() => {
        nowTick.value = Date.now();
    }, 1000);
    void load();
});

onBeforeUnmount(() => {
    stopPolling();
    closeStreams();
    if (clockTimer !== null) clearInterval(clockTimer);
    clockTimer = null;
});

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
        // 刷新回到页面时接管仍在后台执行的运行，继续显示进度与事件流。
        const latest = runs.value[0];
        if (latest && latest.status === 'running') {
            await openRun(latest.runId);
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
    if (selectedIds.value.length === 0 || starting.value || running.value) return;
    starting.value = true;
    error.value = '';
    resetLive();
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
        ensureStreams();
        startPolling(activeRun.value.runId);
        void loadRuns();
    } catch (err) {
        error.value = String(err);
        await loadRuns();
    } finally {
        starting.value = false;
    }
}

async function openRun(runId) {
    stopPolling();
    resetLive();
    try {
        const detail = await api(`/api/eval/runs/${encodeURIComponent(runId)}`);
        activeRun.value = detail;
        if (detail.status === 'running') {
            ensureStreams();
            startPolling(detail.runId);
        }
    } catch (err) {
        error.value = String(err);
    }
}

async function stopActive() {
    const run = activeRun.value;
    if (!run || run.status !== 'running' || stopBusy.value) return;
    stopBusy.value = true;
    error.value = '';
    try {
        const response = await api(`/api/eval/runs/${encodeURIComponent(run.runId)}/stop`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
        });
        if (response.run) activeRun.value = response.run;
        ensureStreams();
    } catch (err) {
        error.value = String(err);
    } finally {
        stopBusy.value = false;
    }
}

async function stopTask(taskId) {
    const run = activeRun.value;
    if (!run || run.status !== 'running') return;
    error.value = '';
    try {
        const response = await api(`/api/eval/runs/${encodeURIComponent(run.runId)}/stop`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ taskId }),
        });
        if (response.run) activeRun.value = response.run;
    } catch (err) {
        error.value = String(err);
    }
}

async function resumeActive() {
    const run = activeRun.value;
    if (!run || resumeBusy.value) return;
    resumeBusy.value = true;
    error.value = '';
    resetLive();
    try {
        activeRun.value = await api(`/api/eval/runs/${encodeURIComponent(run.runId)}/resume`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
        });
        ensureStreams();
        startPolling(activeRun.value.runId);
    } catch (err) {
        error.value = String(err);
    } finally {
        resumeBusy.value = false;
    }
}

async function decide(taskId, approval, decision, scope) {
    try {
        await respondApproval(approval.invocationId, decision, scope);
        const live = taskLive[taskId];
        if (live) {
            live.approvals = live.approvals.filter(
                (item) => item.invocationId !== approval.invocationId,
            );
        }
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

function startPolling(runId) {
    stopPolling();
    pollTimer = setInterval(() => {
        void refreshActive(runId);
    }, 900);
}

function stopPolling() {
    if (pollTimer !== null) clearInterval(pollTimer);
    pollTimer = null;
}

async function refreshActive(runId) {
    if (!activeRun.value || activeRun.value.runId !== runId) return;
    try {
        const detail = await api(`/api/eval/runs/${encodeURIComponent(runId)}`);
        if (!activeRun.value || activeRun.value.runId !== runId) return;
        activeRun.value = detail;
        ensureStreams();
        if (detail.status !== 'running') {
            stopPolling();
            closeStreams();
            void loadRuns();
        }
    } catch (err) {
        error.value = String(err);
    }
}

function ensureStreams() {
    const progress = activeProgress.value;
    const live = new Map(
        progress
            .filter((item) => item.rootGoalId && (item.status === 'running' || item.status === 'stopping'))
            .map((item) => [item.taskId, item.rootGoalId]),
    );
    for (const [taskId, source] of sources) {
        if (!live.has(taskId)) {
            source.close();
            sources.delete(taskId);
        }
    }
    for (const [taskId, rootGoalId] of live) {
        if (sources.has(taskId)) continue;
        if (taskLive[taskId] === undefined) taskLive[taskId] = initialArmLive('running');
        const source = new EventSource(
            `${API_BASE}/api/events/${encodeURIComponent(rootGoalId)}?follow=1`,
        );
        const consume = (event) => {
            let parsed;
            try {
                parsed = JSON.parse(event.data);
            } catch {
                return;
            }
            const current = taskLive[taskId] ?? initialArmLive('running');
            taskLive[taskId] = applyArmEvent(current, parsed);
        };
        for (const type of ARM_EVENT_TYPES) source.addEventListener(type, consume);
        source.onerror = () => {
            // EventSource 自带重连；后端收尾时连接关闭即可。
        };
        sources.set(taskId, source);
    }
}

function closeStreams() {
    for (const source of sources.values()) source.close();
    sources.clear();
}

function resetLive() {
    stopPolling();
    closeStreams();
    for (const key of Object.keys(taskLive)) delete taskLive[key];
}

function recentSteps(taskId) {
    const live = taskLive[taskId];
    return live ? live.steps.slice(-4) : [];
}

function streamTextOf(taskId) {
    const live = taskLive[taskId];
    return live ? armStreamText(live).slice(-600) : '';
}

function approvalsOf(taskId) {
    return taskLive[taskId]?.approvals ?? [];
}

function taskStatusLabel(status) {
    return (
        {
            pending: '等待',
            running: '执行中',
            stopping: '停止中',
            stopped: '已停止',
            completed: '完成',
            failed: '失败',
        }[status] ?? status
    );
}

function taskStatusTone(status) {
    if (status === 'completed') return 'ok';
    if (status === 'failed') return 'bad';
    if (status === 'stopped' || status === 'stopping') return 'warn';
    if (status === 'running') return 'live';
    return '';
}

function runTone(status) {
    if (status === 'completed') return 'ok';
    if (status === 'running') return 'live';
    if (status === 'aborted') return 'warn';
    return 'bad';
}

function elapsedOf(item) {
    if (!item.startedAt) return '-';
    return duration((item.endedAt ?? nowTick.value) - item.startedAt);
}

function percent(value) {
    return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function duration(ms) {
    const value = Number(ms || 0);
    if (value < 1000) return `${Math.round(value)}ms`;
    if (value < 60000) return `${(value / 1000).toFixed(1)}s`;
    return `${Math.floor(value / 60000)}m${Math.round((value % 60000) / 1000)}s`;
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
                    <div class="eval-run-actions">
                        <button
                            class="eval-run"
                            type="button"
                            :disabled="starting || running || selectedIds.length === 0"
                            @click="runSelected"
                        >
                            <LineIcon name="play" :size="15" />
                            {{
                                running
                                    ? '运行中…'
                                    : starting
                                      ? '启动中…'
                                      : `运行已选 ${selectedIds.length} 项`
                            }}
                        </button>
                    </div>
                </section>

                <section v-if="activeRun" class="eval-progress">
                    <div class="eval-progress-head">
                        <span class="eval-status" :class="runTone(activeRun.status)">
                            {{ activeRun.status }}
                        </span>
                        <strong>运行进度</strong>
                        <span class="eval-progress-summary">
                            {{ doneCount }}/{{ activeProgress.length }} 完成 ·
                            {{ liveCount }} 执行中 · {{ stoppedCount }} 已停止
                        </span>
                        <code class="eval-run-id">{{ activeRun.runId.slice(0, 8) }}</code>
                        <button
                            v-if="running"
                            type="button"
                            class="eval-stop"
                            :disabled="stopBusy"
                            @click="stopActive"
                        >
                            {{ stopBusy ? '停止中…' : '全部停止' }}
                        </button>
                        <button
                            v-if="canResume"
                            type="button"
                            class="eval-resume"
                            :disabled="resumeBusy"
                            @click="resumeActive"
                        >
                            {{ resumeBusy ? '恢复中…' : `从断点继续 ${resumable.length} 项` }}
                        </button>
                    </div>

                    <div class="eval-progress-list">
                        <article
                            v-for="item in activeProgress"
                            :key="item.taskId"
                            class="eval-progress-task"
                        >
                            <header>
                                <span class="eval-status" :class="taskStatusTone(item.status)">
                                    {{ taskStatusLabel(item.status) }}
                                </span>
                                <strong>{{ item.title }}</strong>
                                <span class="eval-elapsed">{{ elapsedOf(item) }}</span>
                                <button
                                    v-if="item.status === 'running' && running"
                                    type="button"
                                    class="eval-task-stop"
                                    @click="stopTask(item.taskId)"
                                >
                                    停止此任务
                                </button>
                            </header>
                            <div class="eval-progress-meta">
                                <code v-if="item.rootGoalId">{{ item.rootGoalId.slice(0, 8) }}</code>
                                <span v-if="item.error" class="eval-task-error">{{ item.error }}</span>
                                <span v-if="item.status === 'stopped'" class="eval-task-hint">
                                    已停止，可从断点继续（保留已完成步骤）
                                </span>
                            </div>

                            <ol v-if="recentSteps(item.taskId).length" class="eval-live-steps">
                                <li
                                    v-for="step in recentSteps(item.taskId)"
                                    :key="step.stepId"
                                    :class="{ active: step.status === 'active' }"
                                >
                                    <span class="eval-step-kind">{{ step.kind }}</span>
                                    <span class="eval-step-title">{{ step.title }}</span>
                                </li>
                            </ol>
                            <pre v-if="streamTextOf(item.taskId)" class="eval-stream">{{
                                streamTextOf(item.taskId)
                            }}</pre>

                            <div
                                v-for="approval in approvalsOf(item.taskId)"
                                :key="approval.invocationId"
                                class="eval-approval"
                            >
                                <div>
                                    <strong>等待审批 · {{ approval.toolName || '工具' }}</strong>
                                    <p>{{ approval.summary || '该步骤需要人工确认后才会继续。' }}</p>
                                </div>
                                <div class="eval-approval-actions">
                                    <button
                                        type="button"
                                        @click="decide(item.taskId, approval, 'granted', 'once')"
                                    >
                                        允许一次
                                    </button>
                                    <button
                                        type="button"
                                        @click="decide(item.taskId, approval, 'granted', 'session')"
                                    >
                                        本会话
                                    </button>
                                    <button
                                        type="button"
                                        class="danger"
                                        @click="decide(item.taskId, approval, 'rejected')"
                                    >
                                        拒绝
                                    </button>
                                </div>
                            </div>
                        </article>
                    </div>
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

                <section v-else-if="!activeRun" class="eval-empty">
                    <LineIcon name="observation" :size="30" />
                    <strong>选择一个或多个任务后运行</strong>
                    <p>运行中会逐任务展示步骤、流式输出与审批，可随时停止并从断点继续。</p>
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
                        <span class="eval-status" :class="runTone(run.status)">
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
.eval-run-row,
.eval-progress-head,
.eval-progress-task header {
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
.eval-run,
.eval-stop,
.eval-resume,
.eval-task-stop,
.eval-approval-actions button {
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
.eval-run-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
}
.eval-run {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: var(--accent);
    color: #fff;
    border-color: transparent;
    padding: 7px 12px;
}
.eval-run:disabled,
.eval-actions button:disabled,
.eval-stop:disabled,
.eval-resume:disabled {
    opacity: 0.55;
    cursor: default;
}
.eval-progress {
    display: flex;
    flex-direction: column;
    gap: 8px;
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
    padding: 10px;
}
.eval-progress-head {
    flex-wrap: wrap;
    gap: 8px;
}
.eval-progress-head strong {
    font-size: 12px;
}
.eval-progress-summary,
.eval-run-id,
.eval-elapsed {
    color: var(--fg-tertiary);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
}
.eval-run-id {
    margin-left: auto;
}
.eval-stop {
    border-color: color-mix(in srgb, var(--error) 40%, var(--border));
    color: var(--error);
}
.eval-resume {
    border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
    color: var(--accent);
}
.eval-progress-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 360px;
    overflow-y: auto;
}
.eval-progress-task {
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 5px;
}
.eval-progress-task header {
    gap: 8px;
}
.eval-progress-task header strong {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
}
.eval-task-stop {
    padding: 2px 7px;
    font-size: 10px;
    color: var(--warn);
}
.eval-progress-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 10px;
    color: var(--fg-tertiary);
}
.eval-task-error {
    color: var(--error);
}
.eval-task-hint {
    color: var(--warn);
}
.eval-live-steps {
    margin: 0;
    padding-left: 16px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 11px;
    color: var(--fg-secondary);
}
.eval-live-steps li.active .eval-step-title {
    color: var(--fg);
}
.eval-step-kind {
    display: inline-block;
    min-width: 74px;
    color: var(--fg-tertiary);
    font-size: 10px;
}
.eval-step-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.eval-live-steps li {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    list-style: none;
}
.eval-stream {
    margin: 0;
    max-height: 110px;
    overflow-y: auto;
    padding: 6px 8px;
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--fg-secondary);
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-word;
}
.eval-approval {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 8px;
    border-radius: var(--radius-sm);
    border: 1px solid color-mix(in srgb, var(--warn) 35%, var(--border));
    background: color-mix(in srgb, var(--warn) 8%, transparent);
}
.eval-approval strong {
    font-size: 11px;
}
.eval-approval p {
    margin: 2px 0 0;
    font-size: 11px;
    color: var(--fg-secondary);
}
.eval-approval-actions {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
}
.eval-approval-actions button {
    padding: 2px 6px;
    font-size: 10px;
}
.eval-approval-actions button.danger {
    color: var(--error);
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
.eval-status.warn {
    background: color-mix(in srgb, var(--warn) 14%, transparent);
    color: var(--warn);
}
.eval-status.live {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
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
